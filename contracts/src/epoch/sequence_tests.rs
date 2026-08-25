use super::*;
use cosmwasm_std::testing::{message_info, mock_env};
use cosmwasm_std::{
    Addr, Binary, Coin as CwCoin, ContractResult, DecCoin, Decimal256, FullDelegation,
    SystemResult, Timestamp, Validator as CwValidator,
};
use provwasm_common::MockableQuerier;
use provwasm_mocks::{mock_provenance_dependencies, MockProvenanceQuerier};
use provwasm_std::types::cosmos::auth::v1beta1::BaseAccount;
use provwasm_std::types::cosmos::base::v1beta1::Coin as PbCoin;
use provwasm_std::types::cosmos::slashing::v1beta1::{
    Params as SlashingParams, QueryParamsResponse as SlashingParamsResponse,
};
use provwasm_std::types::cosmos::staking::v1beta1::{
    BondStatus, Pool, QueryDelegatorUnbondingDelegationsResponse, QueryPoolResponse,
    QueryRedelegationsResponse, QueryValidatorsResponse, Validator as PValidator,
};
use provwasm_std::types::provenance::marker::v1::QueryMarkerResponse;
use provwasm_std::types::provlabs::vault::v1::{
    AccountBalance, QueryVaultPendingSwapOutsResponse, QueryVaultResponse, VaultAccount,
};

use crate::msg::InstantiateMsg;
use crate::state::{ValidatorRecord, VALIDATORS};
use crate::vault_ext::{ACCEPT_ASSET_TYPE_URL, UPDATE_VAULT_NAV_TYPE_URL};

const VALOPER: &str = "tpvaloper1seq0000000000000000000000000000000000";

/// Register a protobuf-encoded response for a gRPC query path, wrapped in
/// the ABCI ResponseQuery envelope the generated queriers decode.
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

/// Collapse a CosmosMsg to a short label for sequence assertions.
fn kind(msg: &CosmosMsg) -> &'static str {
    match msg {
        CosmosMsg::Distribution(DistributionMsg::WithdrawDelegatorReward { .. }) => "claim",
        CosmosMsg::Staking(StakingMsg::Undelegate { .. }) => "undelegate",
        CosmosMsg::Staking(StakingMsg::Redelegate { .. }) => "redelegate",
        CosmosMsg::Staking(StakingMsg::Delegate { .. }) => "delegate",
        CosmosMsg::Any(any) => match any.type_url.as_str() {
            "/provenance.exchange.v1.MsgCreatePaymentRequest" => "create_payment",
            ACCEPT_ASSET_TYPE_URL => "accept_asset",
            UPDATE_VAULT_NAV_TYPE_URL => "update_nav",
            "/provlabs.vault.v1.MsgPauseVaultRequest" => "pause",
            "/provlabs.vault.v1.MsgDepositPrincipalFundsRequest" => "deposit_principal",
            "/provlabs.vault.v1.MsgUnpauseVaultRequest" => "unpause",
            "/provlabs.vault.v1.MsgExpeditePendingSwapOutRequest" => "expedite",
            "/provenance.marker.v1.MsgTransferRequest" => "transfer_receipt",
            "/provenance.marker.v1.MsgBurnRequest" => "burn_receipt",
            "/provenance.marker.v1.MsgMintRequest" => "mint_receipt",
            other => panic!("unexpected Any message in epoch crank: {other}"),
        },
        other => panic!("unexpected message variant in epoch crank: {other:?}"),
    }
}

/// Mocked deps + env covering run_epoch's full query surface. `contract_liquid` is
/// the contract's nhash bank balance, `vault_liquid` the principal marker's liquid
/// nhash, `reward` the enrolled validator's claimable rewards.
fn setup(
    contract_liquid: u128,
    vault_liquid: u128,
    reward: u128,
) -> (
    cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        MockProvenanceQuerier,
    >,
    Env,
) {
    let mut deps = mock_provenance_dependencies();
    let env = mock_env();
    let contract = env.contract.address.to_string();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let marker = deps.api.addr_make("receipt-marker");

    crate::contract::instantiate(
        deps.as_mut(),
        env.clone(),
        message_info(&admin, &[]),
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
            commission_bps: Some(0),
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
    )
    .unwrap();

    // One enrolled, bonded, eligible validator holding the program's stake.
    VALIDATORS
        .save(
            &mut deps.storage,
            VALOPER,
            &ValidatorRecord {
                operator: Addr::unchecked("op"),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 10_000,
                uptime_count: 1,
                commission_accrued: Uint128::zero(),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();
    // 1_500 receipt outstanding vs 1_000 still staked: 500 matured back.
    RECEIPT_MINTED
        .save(&mut deps.storage, &Uint128::new(1_500))
        .unwrap();

    // --- native queries: bank, staking delegations, distribution rewards ---
    deps.querier
        .mock_querier
        .bank
        .update_balance(&contract, vec![CwCoin::new(contract_liquid, "nhash")]);
    let zero = CwCoin::new(0u128, "nhash");
    deps.querier.mock_querier.staking.update(
        "nhash",
        &[CwValidator::create(
            VALOPER.to_string(),
            cosmwasm_std::Decimal::zero(),
            cosmwasm_std::Decimal::one(),
            cosmwasm_std::Decimal::one(),
        )],
        &[FullDelegation::create(
            Addr::unchecked(&contract),
            VALOPER.to_string(),
            CwCoin::new(1_000u128, "nhash"),
            zero.clone(),
            vec![],
        )],
    );
    if reward > 0 {
        deps.querier
            .mock_querier
            .distribution
            .set_validators(&contract, [VALOPER]);
        deps.querier.mock_querier.distribution.set_rewards(
            VALOPER,
            &contract,
            vec![DecCoin::new(
                Decimal256::from_atomics(reward, 0).unwrap(),
                "nhash",
            )],
        );
    }

    // --- gRPC queries ---
    let q = &mut deps.querier;
    grpc(
        q,
        "/cosmos.staking.v1beta1.Query/Validators",
        &QueryValidatorsResponse {
            validators: vec![PValidator {
                operator_address: VALOPER.to_string(),
                jailed: false,
                status: BondStatus::Bonded as i32,
                tokens: "1000".to_string(),
                ..Default::default()
            }],
            pagination: None,
        },
    );
    grpc(
        q,
        "/cosmos.staking.v1beta1.Query/Pool",
        &QueryPoolResponse {
            pool: Some(Pool {
                not_bonded_tokens: "0".to_string(),
                bonded_tokens: "1000000".to_string(),
            }),
        },
    );
    grpc(
        q,
        "/cosmos.slashing.v1beta1.Query/Params",
        &SlashingParamsResponse {
            params: Some(SlashingParams {
                signed_blocks_window: 100,
                ..Default::default()
            }),
        },
    );
    grpc(
        q,
        "/cosmos.staking.v1beta1.Query/DelegatorUnbondingDelegations",
        &QueryDelegatorUnbondingDelegationsResponse {
            unbonding_responses: vec![],
            pagination: None,
        },
    );
    grpc(
        q,
        "/cosmos.staking.v1beta1.Query/Redelegations",
        &QueryRedelegationsResponse {
            redelegation_responses: vec![],
            pagination: None,
        },
    );
    grpc(
        q,
        "/provlabs.vault.v1.Query/VaultPendingSwapOuts",
        &QueryVaultPendingSwapOutsResponse {
            pending_swap_outs: vec![],
            pagination: None,
        },
    );
    grpc(
        q,
        "/provlabs.vault.v1.Query/Vault",
        &QueryVaultResponse {
            vault: Some(VaultAccount {
                total_shares: Some(PbCoin {
                    denom: "nvhash".to_string(),
                    amount: "20000000000".to_string(),
                }),
                ..Default::default()
            }),
            principal: Some(AccountBalance {
                address: String::new(),
                coins: vec![PbCoin {
                    denom: "nhash".to_string(),
                    amount: vault_liquid.to_string(),
                }],
            }),
            reserves: None,
            total_vault_value: Some(PbCoin {
                denom: "nhash".to_string(),
                amount: (vault_liquid + 1_500).to_string(),
            }),
        },
    );
    grpc(
        q,
        "/provenance.marker.v1.Query/Marker",
        &QueryMarkerResponse {
            marker: Some(provwasm_std::shim::Any {
                type_url: "/provenance.marker.v1.MarkerAccount".to_string(),
                value: MarkerAccount {
                    base_account: Some(BaseAccount {
                        address: marker.to_string(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }
                .encode_to_vec(),
            }),
        },
    );

    (deps, env)
}

fn decode_any<M: prost::Message + Default>(msg: &CosmosMsg, expect_kind: &str) -> M {
    assert_eq!(kind(msg), expect_kind);
    let CosmosMsg::Any(any) = msg else {
        unreachable!()
    };
    M::decode(any.value.as_slice()).unwrap()
}

/// Reward-deposit path (liquid 800 > matured 500). Locks: settlement before pause,
/// deposit inside pause/unpause, transfer-then-burn after unpause, deploy and
/// delegations last.
#[test]
fn run_epoch_orders_settle_pause_deposit_burn_deploy() {
    let (mut deps, env) = setup(800, 10_000, 100);
    let res = run_epoch(deps.as_mut(), env).unwrap();
    let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();
    assert_eq!(
        kinds,
        vec![
            "claim",          // Phase A: withdraw rewards
            "update_nav",     // par restate: the settlements below need the entry
            "create_payment", // return settlement (unpaused)
            "accept_asset",
            "pause",             // Phase C: pause window opens
            "deposit_principal", // the NAV step, inside the window
            "unpause",           // window closes
            "transfer_receipt",  // burn leg: receipt into the marker account
            "burn_receipt",
            "mint_receipt", // deploy settlement
            "update_nav",   // its own par restate (the return leg may drain the entry)
            "create_payment",
            "accept_asset",
            "delegate", // fresh stake last
        ],
        "run_epoch message order changed — the pause-window and settlement \
         safety story depends on this exact sequence"
    );
    // The par restate prices 1 receipt unit at 1 nhash and nothing else.
    let assert_nav: crate::vault_ext::MsgUpdateVaultNavRequest =
        decode_any(&res.messages[1].msg, "update_nav");
    assert_eq!(assert_nav.price.unwrap().amount, "1");
    assert_eq!(assert_nav.volume, "1");
    assert_eq!(assert_nav.denom, "nvhash.staked");
    // The deposit inside the window is exactly liquid - settle = 300.
    let dep: MsgDepositPrincipalFundsRequest =
        decode_any(&res.messages[5].msg, "deposit_principal");
    assert_eq!(dep.amount.unwrap().amount, "300");
    // Burn is exactly the matured receipt.
    let burn: MsgBurnRequest = decode_any(&res.messages[8].msg, "burn_receipt");
    assert_eq!(burn.amount.unwrap().amount, "500");
    // Receipt counter: 1500 outstanding + 9950 deployed - 500 burned.
    let minted: MsgMintRequest = decode_any(&res.messages[9].msg, "mint_receipt");
    assert_eq!(minted.amount.unwrap().amount, "9950");
    assert_eq!(
        RECEIPT_MINTED.load(&deps.storage).unwrap(),
        Uint128::new(1_500 + 9_950 - 500)
    );
}

/// Write-down path (liquid 300 < matured 500): the shortfall is recognized this
/// crank. Locks the bracketed sandwich order and that the burn covers settle + write_down.
#[test]
fn run_epoch_orders_write_down_sandwich_in_pause_brackets() {
    let (mut deps, env) = setup(300, 0, 0);
    let res = run_epoch(deps.as_mut(), env).unwrap();
    let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();
    assert_eq!(
        kinds,
        vec![
            "update_nav",     // par restate before the first settlement
            "create_payment", // return settlement for the backed 300
            "accept_asset",
            "pause",      // mark bracket: repricing a held asset needs a pause
            "update_nav", // mark receipt to 0 for 200 units
            "unpause",
            "create_payment", // zero-priced extraction, vault live again
            "accept_asset",
            "pause",      // close-out bracket
            "update_nav", // restore the exact 1:1 entry
            "unpause",
            "transfer_receipt",
            "burn_receipt", // settle + write_down burned together
        ],
        "write-down sandwich order changed — a fractional markdown, a \
         reordered restore, or an unbracketed reprice breaks the money path"
    );
    // The mark prices 200 units at 0; the restore returns the entry to 1 nhash per unit.
    let mark: crate::vault_ext::MsgUpdateVaultNavRequest =
        decode_any(&res.messages[4].msg, "update_nav");
    assert_eq!(mark.price.unwrap().amount, "0");
    assert_eq!(mark.volume, "200");
    let restore: crate::vault_ext::MsgUpdateVaultNavRequest =
        decode_any(&res.messages[9].msg, "update_nav");
    assert_eq!(restore.price.unwrap().amount, "1");
    assert_eq!(restore.volume, "1");
    // Nothing is deposited on this path: the close-out bracket carries the restore alone.
    assert!(!kinds.contains(&"deposit_principal"));
    let burn: MsgBurnRequest = decode_any(&res.messages[12].msg, "burn_receipt");
    assert_eq!(burn.amount.unwrap().amount, "500");
    assert_eq!(
        RECEIPT_MINTED.load(&deps.storage).unwrap(),
        Uint128::new(1_000)
    );
}

/// The vault settles only when the payment matches the approval's terms exactly;
/// walks every settlement pair on both paths to prove the two legs describe one deal.
#[test]
fn settlement_pairs_carry_identical_terms() {
    for (liquid, vault_liquid, reward) in [(800u128, 10_000u128, 100u128), (300, 0, 0)] {
        let (mut deps, env) = setup(liquid, vault_liquid, reward);
        let contract = env.contract.address.to_string();
        let vault = CONFIG
            .load(&deps.storage)
            .unwrap()
            .vault_address
            .to_string();
        let res = run_epoch(deps.as_mut(), env).unwrap();
        let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();

        let pairs: Vec<usize> = kinds
            .iter()
            .enumerate()
            .filter(|(_, k)| **k == "create_payment")
            .map(|(i, _)| i)
            .collect();
        assert!(!pairs.is_empty(), "expected settlements for {liquid}");
        for i in pairs {
            assert_eq!(kinds[i + 1], "accept_asset", "accept must follow create");
            let created: MsgCreatePaymentRequest =
                decode_any(&res.messages[i].msg, "create_payment");
            let accepted: crate::vault_ext::MsgAcceptAssetRequest =
                decode_any(&res.messages[i + 1].msg, "accept_asset");
            let created = created.payment.expect("create carries a payment");
            let approved = accepted.payment.expect("accept carries a payment");

            assert_eq!(created.source, approved.source);
            assert_eq!(created.external_id, approved.external_id);
            assert_eq!(created.target, approved.target);
            assert_eq!(created.source_amount.len(), approved.source_amount.len());
            for (a, b) in created.source_amount.iter().zip(&approved.source_amount) {
                assert_eq!((&a.denom, &a.amount), (&b.denom, &b.amount));
            }
            assert_eq!(created.target_amount.len(), approved.target_amount.len());
            for (a, b) in created.target_amount.iter().zip(&approved.target_amount) {
                assert_eq!((&a.denom, &a.amount), (&b.denom, &b.amount));
            }
            // The contract sources every settlement; the vault must be the target.
            assert_eq!(created.source, contract);
            assert_eq!(approved.target, vault);
        }
    }
}

/// The vault settles only while live and reprices a held asset only while paused;
/// tracks pause depth and asserts each message sits on the side it needs.
#[test]
fn settlements_run_live_and_repricings_run_paused() {
    for (liquid, vault_liquid, reward) in [(800u128, 10_000u128, 100u128), (300, 0, 0)] {
        let (mut deps, env) = setup(liquid, vault_liquid, reward);
        let res = run_epoch(deps.as_mut(), env).unwrap();
        let mut paused = false;
        for msg in res.messages.iter() {
            match kind(&msg.msg) {
                "pause" => {
                    assert!(!paused, "double pause: the vault rejects it");
                    paused = true;
                }
                "unpause" => {
                    assert!(paused, "unpause without a pause");
                    paused = false;
                }
                "accept_asset" => assert!(
                    !paused,
                    "settlement emitted while paused — the vault rejects it"
                ),
                "deposit_principal" => {
                    assert!(paused, "principal deposit requires a paused vault")
                }
                "update_nav" => {
                    let nav: crate::vault_ext::MsgUpdateVaultNavRequest =
                        decode_any(&msg.msg, "update_nav");
                    // A par restate is legal live; any other price requires the pause.
                    let is_par = nav.price.as_ref().map(|p| p.amount.as_str()) == Some("1")
                        && nav.volume == "1";
                    assert!(
                        paused || is_par,
                        "off-par repricing while live — the vault rejects it"
                    );
                }
                _ => {}
            }
        }
        assert!(!paused, "crank ended with the vault paused");
    }
}

/// A draining settlement removes the NAV entry a later leg needs, so every par
/// settlement must be immediately preceded by its own par restate; the write-down
/// extraction alone settles at the marked-down price on purpose.
#[test]
fn every_par_settlement_is_preceded_by_a_par_restate() {
    for (liquid, vault_liquid, reward) in [(800u128, 10_000u128, 100u128), (300, 0, 0)] {
        let (mut deps, env) = setup(liquid, vault_liquid, reward);
        let res = run_epoch(deps.as_mut(), env).unwrap();
        let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();

        for (i, k) in kinds.iter().enumerate() {
            if *k != "create_payment" {
                continue;
            }
            let approved: crate::vault_ext::MsgAcceptAssetRequest =
                decode_any(&res.messages[i + 1].msg, "accept_asset");
            let payment = approved.payment.unwrap();
            if payment.external_id == WRITEDOWN_PAYMENT_ID {
                // The extraction rides the marked-down entry, after the mark bracket's unpause.
                assert_eq!(kinds[i - 1], "unpause");
                continue;
            }
            assert_eq!(
                kinds[i - 1],
                "update_nav",
                "settlement '{}' is not guarded by a par restate",
                payment.external_id
            );
            let guard: crate::vault_ext::MsgUpdateVaultNavRequest =
                decode_any(&res.messages[i - 1].msg, "update_nav");
            assert_eq!(guard.price.unwrap().amount, "1");
            assert_eq!(guard.volume, "1");
            assert_eq!(guard.denom, "nvhash.staked");
        }
    }
}

/// A crank never both writes down and deposits: plan_return settles the whole
/// matured amount whenever liquid covers it. Pinned because the sequence tests
/// only cover the two reachable shapes.
#[test]
fn write_down_and_reward_deposit_are_mutually_exclusive() {
    for liquid in [0u128, 1, 299, 300, 499, 500, 501, 5_000] {
        let ret = plan_return(
            Uint128::new(1_500),
            Uint128::new(1_000),
            Uint128::zero(),
            Uint128::new(liquid),
        );
        let rewards_dep = Uint128::new(liquid).saturating_sub(ret.settle);
        assert!(
            ret.write_down.is_zero() || rewards_dep.is_zero(),
            "liquid={liquid} produced both a write-down and a deposit"
        );
    }
}
