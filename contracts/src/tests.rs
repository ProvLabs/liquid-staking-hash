use cosmwasm_std::{coin, Addr, Coin, Uint128};
use provwasm_std::types::cosmos::staking::v1beta1::{
    CommissionRates, Description as StakingDescription, MsgCreateValidator,
    MsgCreateValidatorResponse,
};
use provwasm_std::types::provlabs::vault::v1::{
    MsgCreateVaultRequest, MsgCreateVaultResponse, MsgPauseVaultRequest, MsgPauseVaultResponse,
    MsgSetAssetManagerRequest, MsgSetAssetManagerResponse, MsgUnpauseVaultRequest,
    MsgUnpauseVaultResponse, QueryVaultRequest, QueryVaultResponse,
};
use provwasm_test_tube::{
    fn_execute,
    provwasm_std::types::provenance::marker::v1::{
        Access, AccessGrant, MarkerStatus, MarkerType, MsgActivateRequest, MsgAddMarkerRequest,
    },
    wasm::Wasm,
    Account, Module, ProvwasmTestApp, Runner, RunnerError, SigningAccount,
};

use crate::msg::{
    ConfigResponse, EpochStatusResponse, ExecuteMsg, InstantiateMsg, QueryMsg, ValidatorsResponse,
};

// test-tube's genesis exposes `nhash` only as a native coin (no marker), and
// create_vault requires the underlying to be a marker. We therefore stand up a
// dedicated restricted marker as the test vault's underlying (in Design C
// production the underlying IS nhash directly, since payment_denom collapses
// onto the underlying; this substitution only strengthens the correspondence).
// What these tests prove is the asset-manager authority path and the crank
// plumbing, which are independent of which denom backs the vault. Full Design C
// settlement (receipt-marker AcceptAsset) is exercised on the devnet drill,
// since test-tube 0.5.0 does not ship AcceptAsset.
const FUNDING_DENOM: &str = "nhash";
const UNDERLYING_DENOM: &str = "nvhash.underlying";
const SHARE_DENOM: &str = "nvhash.shares";
const RECEIPT_DENOM: &str = "nvhash.staked";

pub struct Vault<'a, R: Runner<'a>> {
    runner: &'a R,
}

impl<'a, R: Runner<'a>> Module<'a, R> for Vault<'a, R> {
    fn new(runner: &'a R) -> Self {
        Self { runner }
    }
}

impl<'a, R> Vault<'a, R>
where
    R: Runner<'a>,
{
    fn_execute! {
        pub create_vault: MsgCreateVaultRequest["/provlabs.vault.v1.MsgCreateVaultRequest"] => MsgCreateVaultResponse
    }
    fn_execute! {
        pub set_asset_manager: MsgSetAssetManagerRequest["/provlabs.vault.v1.MsgSetAssetManagerRequest"] => MsgSetAssetManagerResponse
    }
    fn_execute! {
        pub pause_vault: MsgPauseVaultRequest["/provlabs.vault.v1.MsgPauseVaultRequest"] => MsgPauseVaultResponse
    }
    fn_execute! {
        pub unpause_vault: MsgUnpauseVaultRequest["/provlabs.vault.v1.MsgUnpauseVaultRequest"] => MsgUnpauseVaultResponse
    }
}

fn setup_underlying_marker(
    app: &ProvwasmTestApp,
    admin: &SigningAccount,
) -> Result<(), RunnerError> {
    let marker_module = provwasm_test_tube::marker::Marker::new(app);
    marker_module.add_marker(
        MsgAddMarkerRequest {
            amount: Some(
                Coin {
                    amount: Uint128::zero(),
                    denom: UNDERLYING_DENOM.to_string(),
                }
                .into(),
            ),
            manager: admin.address(),
            from_address: admin.address(),
            status: MarkerStatus::Finalized.into(),
            marker_type: MarkerType::Restricted.into(),
            access_list: vec![AccessGrant {
                address: admin.address(),
                permissions: vec![
                    Access::Admin.into(),
                    Access::Mint.into(),
                    Access::Burn.into(),
                    Access::Withdraw.into(),
                    Access::Deposit.into(),
                    Access::Transfer.into(),
                ],
            }],
            supply_fixed: false,
            allow_governance_control: true,
            allow_forced_transfer: false,
            ..Default::default()
        },
        admin,
    )?;
    marker_module.activate(
        MsgActivateRequest {
            denom: UNDERLYING_DENOM.to_string(),
            administrator: admin.address().to_string(),
        },
        admin,
    )?;
    Ok(())
}

fn setup_vault(app: &ProvwasmTestApp, admin: &SigningAccount) -> Result<Addr, RunnerError> {
    setup_underlying_marker(app, admin)?;
    let vault_module = Vault::new(app);
    let vault = vault_module.create_vault(
        MsgCreateVaultRequest {
            admin: admin.address(),
            share_denom: SHARE_DENOM.to_string(),
            underlying_asset: UNDERLYING_DENOM.to_string(),
            ..Default::default()
        },
        admin,
    )?;
    Ok(Addr::unchecked(vault.data.vault_address))
}

fn setup_wasm(app: &ProvwasmTestApp, admin: &SigningAccount, vault_address: &Addr) -> Addr {
    setup_wasm_with_underlying(app, admin, vault_address, UNDERLYING_DENOM)
}

/// Newest modification time under a path (file or directory, recursive).
fn newest_mtime(path: &std::path::Path) -> Option<std::time::SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return meta.modified().ok();
    }
    std::fs::read_dir(path)
        .ok()?
        .flatten()
        .filter_map(|e| newest_mtime(&e.path()))
        .max()
}

/// Load the optimized artifact, refusing to run against a STALE one: a binary
/// older than the contract source would silently exercise outdated code (the
/// same freshness rule scripts/build-artifact.sh enforces).
fn read_fresh_artifact() -> Vec<u8> {
    const HINT: &str = "build it: contracts/scripts/build-artifact.sh (Docker required)";
    let artifact = std::path::Path::new("artifacts/nvhash_staking.wasm");
    let bytes = std::fs::read(artifact)
        .unwrap_or_else(|_| panic!("artifacts/nvhash_staking.wasm not found — {HINT}"));
    let built_at = artifact
        .metadata()
        .and_then(|m| m.modified())
        .expect("artifact mtime unreadable");
    let newest_src = ["src", "Cargo.toml", "Cargo.lock"]
        .iter()
        .filter_map(|p| newest_mtime(std::path::Path::new(p)))
        .max()
        .expect("contract source mtime unreadable");
    assert!(
        built_at >= newest_src,
        "artifacts/nvhash_staking.wasm is OLDER than the contract source — \
         the suite would test a stale binary; re{HINT}"
    );
    bytes
}

fn setup_wasm_with_underlying(
    app: &ProvwasmTestApp,
    admin: &SigningAccount,
    vault_address: &Addr,
    underlying: &str,
) -> Addr {
    let wasm = Wasm::new(app);
    let wasm_byte_code = read_fresh_artifact();
    // store_code needs more gas than the Auto fee default (4M) as the contract
    // has grown; sign the upload with an explicit gas limit.
    let uploader = app
        .init_account(&[coin(100_000_000_000_000, FUNDING_DENOM)])
        .unwrap()
        .with_fee_setting(provwasm_test_tube::FeeSetting::Custom {
            amount: coin(20_000_000_000, FUNDING_DENOM),
            gas_limit: 20_000_000,
        });
    let code_id = wasm
        .store_code(&wasm_byte_code, None, &uploader)
        .unwrap()
        .data
        .code_id;
    let address = wasm
        .instantiate(
            code_id,
            &InstantiateMsg {
                admin: admin.address(),
                vault_address: vault_address.to_string(),
                underlying_denom: underlying.to_string(),
                receipt_denom: RECEIPT_DENOM.to_string(),
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
            Some(&admin.address()),
            Some("nvhash-staking"),
            &[],
            admin,
        )
        .unwrap()
        .data
        .address;
    Addr::unchecked(address)
}

fn set_asset_manager(
    app: &ProvwasmTestApp,
    admin: &SigningAccount,
    vault_address: &Addr,
    asset_manager: &Addr,
) {
    Vault::new(app)
        .set_asset_manager(
            MsgSetAssetManagerRequest {
                admin: admin.address(),
                vault_address: vault_address.to_string(),
                asset_manager: asset_manager.to_string(),
            },
            admin,
        )
        .unwrap();
}

fn query_vault(app: &ProvwasmTestApp, vault_address: &Addr) -> QueryVaultResponse {
    app.query::<QueryVaultRequest, QueryVaultResponse>(
        "/provlabs.vault.v1.Query/Vault",
        &QueryVaultRequest {
            id: vault_address.to_string(),
        },
    )
    .unwrap()
}

fn base_setup(app: &ProvwasmTestApp) -> (SigningAccount, Addr, Addr) {
    let accounts = app
        .init_accounts(&[coin(100_000_000_000_000, FUNDING_DENOM)], 1)
        .unwrap();
    let admin = accounts.into_iter().next().unwrap();
    let vault_address = setup_vault(app, &admin).unwrap();
    let contract = setup_wasm(app, &admin, &vault_address);
    (admin, vault_address, contract)
}

#[test]
fn instantiate_stores_config() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    let wasm = Wasm::new(&app);
    let resp: ConfigResponse = wasm.query(contract.as_str(), &QueryMsg::Config {}).unwrap();
    assert_eq!(resp.admin, admin.address());
    assert_eq!(resp.vault_address, vault_address.to_string());
    assert_eq!(resp.receipt_denom, RECEIPT_DENOM);
}

#[test]
fn contract_can_pause_and_unpause_vault_as_asset_manager() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let wasm = Wasm::new(&app);

    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::PauseVault {
            reason: "epoch".to_string(),
        },
        &[],
        &admin,
    )
    .unwrap();
    assert!(query_vault(&app, &vault_address).vault.unwrap().paused);

    wasm.execute(contract.as_str(), &ExecuteMsg::UnpauseVault {}, &[], &admin)
        .unwrap();
    assert!(!query_vault(&app, &vault_address).vault.unwrap().paused);
}

#[test]
fn non_admin_cannot_pause() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let stranger = app
        .init_accounts(&[coin(100_000_000_000_000, FUNDING_DENOM)], 1)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let err = Wasm::new(&app)
        .execute(
            contract.as_str(),
            &ExecuteMsg::PauseVault {
                reason: "nope".to_string(),
            },
            &[],
            &stranger,
        )
        .unwrap_err();
    assert!(format!("{err:?}").contains("unauthorized"));
}

#[test]
fn claim_and_service_are_noops_on_empty_vault() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let wasm = Wasm::new(&app);

    // Snapshot observable state before the two cranks so the "no-op" claim is
    // actually checked, not just that the calls didn't error.
    let status_before: EpochStatusResponse = wasm
        .query(contract.as_str(), &QueryMsg::EpochStatus {})
        .unwrap();
    let vault_paused_before = query_vault(&app, &vault_address).vault.unwrap().paused;

    wasm.execute(contract.as_str(), &ExecuteMsg::ClaimRewards {}, &[], &admin)
        .unwrap();
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::ServiceRedemptions {},
        &[],
        &admin,
    )
    .unwrap();

    // An empty vault has nothing to claim and nothing queued to service, so
    // neither crank should move any observable state: the vault stays
    // unpaused, the epoch phase/receipt-minted counter are untouched, and no
    // delegations get queued.
    assert!(!vault_paused_before);
    assert!(!query_vault(&app, &vault_address).vault.unwrap().paused);

    let status_after: EpochStatusResponse = wasm
        .query(contract.as_str(), &QueryMsg::EpochStatus {})
        .unwrap();
    assert_eq!(status_after.phase, status_before.phase);
    assert_eq!(status_after.phase, "Idle");
    assert_eq!(
        status_after.last_run_seconds,
        status_before.last_run_seconds
    );
    assert_eq!(status_after.receipt_minted, status_before.receipt_minted);
    assert_eq!(status_after.receipt_minted, Uint128::zero());
    assert_eq!(
        status_after.pending_delegations,
        status_before.pending_delegations
    );
    assert!(status_after.pending_delegations.is_empty());
}

/// Derive the valoper address for an account: same key payload, valoper HRP.
fn valoper_of(account_addr: &str) -> String {
    let (hrp, payload) = bech32::decode(account_addr).unwrap();
    let valoper_hrp = bech32::Hrp::parse(&format!("{}valoper", hrp.as_str())).unwrap();
    bech32::encode::<bech32::Bech32>(valoper_hrp, &payload).unwrap()
}

pub struct Staking<'a, R: Runner<'a>> {
    runner: &'a R,
}

impl<'a, R: Runner<'a>> Module<'a, R> for Staking<'a, R> {
    fn new(runner: &'a R) -> Self {
        Self { runner }
    }
}

impl<'a, R> Staking<'a, R>
where
    R: Runner<'a>,
{
    fn_execute! {
        pub create_validator: MsgCreateValidator["/cosmos.staking.v1beta1.MsgCreateValidator"] => MsgCreateValidatorResponse
    }
}

/// Stand up a real validator whose operator is a funded test account (the
/// test-tube genesis validator's operator key is not recoverable: its operator
/// address derives from the consensus key, so no signable account exists).
#[allow(deprecated)] // delegator_address is deprecated in the SDK but still in the proto
fn create_validator(app: &ProvwasmTestApp, operator: &SigningAccount) -> String {
    use provwasm_std::shim::Any;
    use provwasm_std::types::cosmos::crypto::ed25519::PubKey as Ed25519PubKey;

    let valoper = valoper_of(&operator.address());
    let cons_key = Ed25519PubKey { key: vec![9u8; 32] };
    Staking::new(app)
        .create_validator(
            MsgCreateValidator {
                description: Some(StakingDescription {
                    moniker: "pat-the-reliable".to_string(),
                    ..Default::default()
                }),
                // 60%: satisfies both stock genesis params and the Provenance
                // wisteria uniform-commission pin. Wire format for Dec fields is
                // the 1e18-scaled integer string.
                commission: Some(CommissionRates {
                    rate: "600000000000000000".to_string(),
                    max_rate: "600000000000000000".to_string(),
                    max_change_rate: "10000000000000000".to_string(),
                }),
                min_self_delegation: "1".to_string(),
                delegator_address: "".to_string(),
                validator_address: valoper.clone(),
                pubkey: Some(Any {
                    type_url: "/cosmos.crypto.ed25519.PubKey".to_string(),
                    value: prost::Message::encode_to_vec(&cons_key),
                }),
                value: Some(
                    Coin {
                        denom: FUNDING_DENOM.to_string(),
                        amount: Uint128::new(10_000_000_000_000),
                    }
                    .into(),
                ),
            },
            operator,
        )
        .unwrap();
    valoper
}

/// Full enrollment lifecycle against the real embedded chain: a validator is
/// created from a funded account, its operator registers, the live-eligibility
/// query sweeps real staking/slashing state (bonded set, pool, params,
/// SigningInfo via the derived cons address), an uptime capture folds into the
/// accumulator, an epoch crank runs with an enrolled validator, and the admin
/// unregisters.
#[test]
fn validator_enrollment_eligibility_and_capture_flow() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let wasm = Wasm::new(&app);

    let operator = app
        .init_accounts(&[coin(100_000_000_000_000, FUNDING_DENOM)], 1)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let valoper = create_validator(&app, &operator);

    // A stranger cannot register someone else's validator.
    let err = wasm
        .execute(
            contract.as_str(),
            &ExecuteMsg::RegisterParticipation {
                valoper: valoper.clone(),
            },
            &[],
            &admin,
        )
        .unwrap_err();
    assert!(format!("{err:?}").contains("not the operator"));

    // The operator can.
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::RegisterParticipation {
            valoper: valoper.clone(),
        },
        &[],
        &operator,
    )
    .unwrap();

    // Live assessment reads real chain state. With threshold 0 the bonded,
    // unjailed validator is eligible; holding nearly the whole bond itself, its
    // concentration headroom is zero (33% cap < its ~100% share). Its uptime is
    // below perfect (the synthetic consensus key never signs) but well above
    // zero this early in the signing window.
    let resp: ValidatorsResponse = wasm
        .query(contract.as_str(), &QueryMsg::Validators {})
        .unwrap();
    assert_eq!(resp.validators.len(), 1);
    let v = &resp.validators[0];
    assert_eq!(v.valoper, valoper);
    assert_eq!(v.operator, operator.address());
    assert!(!v.jailed);
    assert!(!v.tombstoned);
    assert!(v.eligible);
    assert_eq!(v.headroom, Uint128::zero());
    assert_eq!(v.uptime_capture_count, 0);
    assert!(v.uptime_bps.unwrap() > 5_000);

    // Capture folds the live signed-blocks ratio into the epoch accumulator.
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::CaptureUptimeSignal {},
        &[],
        &admin,
    )
    .unwrap();
    let resp: ValidatorsResponse = wasm
        .query(contract.as_str(), &QueryMsg::Validators {})
        .unwrap();
    assert_eq!(resp.validators[0].uptime_capture_count, 1);
    assert!(resp.validators[0].uptime_bps.unwrap() > 5_000);

    // A full epoch crank with an enrolled validator exercises the eligibility
    // sweep inside RunEpoch; the empty vault means nothing deploys, the epoch
    // completes Idle, and the completed epoch resets the uptime accumulator.
    wasm.execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap();
    let status: EpochStatusResponse = wasm
        .query(contract.as_str(), &QueryMsg::EpochStatus {})
        .unwrap();
    assert_eq!(status.phase, "Idle");
    assert_eq!(status.receipt_minted, Uint128::zero());
    let resp: ValidatorsResponse = wasm
        .query(contract.as_str(), &QueryMsg::Validators {})
        .unwrap();
    assert_eq!(resp.validators[0].uptime_capture_count, 0);

    // Admin (governance path) can unregister.
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::UnregisterParticipation { valoper },
        &[],
        &admin,
    )
    .unwrap();
    let resp: ValidatorsResponse = wasm
        .query(contract.as_str(), &QueryMsg::Validators {})
        .unwrap();
    assert!(resp.validators.is_empty());
}

/// Commission and TIP credits with real fund transfers, any payer. Uses a
/// contract instance whose underlying is nhash (as in production): the test
/// vault's restricted-marker underlying cannot ride wasm `funds` (bank-send
/// restriction), while nhash is a native coin. The epoch rollover semantics
/// (tip reset, grace-boundary advance) are covered by unit tests and the
/// devnet drill.
#[test]
fn commission_and_tip_credit_and_query() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, _marker_backed) = base_setup(&app);
    let contract = setup_wasm_with_underlying(&app, &admin, &vault_address, FUNDING_DENOM);
    let wasm = Wasm::new(&app);

    let operator = app
        .init_accounts(&[coin(100_000_000_000_000, FUNDING_DENOM)], 1)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let valoper = create_validator(&app, &operator);
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::RegisterParticipation {
            valoper: valoper.clone(),
        },
        &[],
        &operator,
    )
    .unwrap();

    // Any payer (the admin here, not the operator) may attach funds.
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::PayTip {
            valoper: valoper.clone(),
        },
        &[coin(100, FUNDING_DENOM)],
        &admin,
    )
    .unwrap();
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::PayCommission {
            valoper: valoper.clone(),
        },
        &[coin(55, FUNDING_DENOM)],
        &admin,
    )
    .unwrap();

    let resp: ValidatorsResponse = wasm
        .query(contract.as_str(), &QueryMsg::Validators {})
        .unwrap();
    let v = &resp.validators[0];
    assert_eq!(v.tip_epoch, Uint128::new(100));
    assert_eq!(v.commission_paid, Uint128::new(55));
    assert_eq!(v.commission_accrued, Uint128::zero()); // no rewards claimed yet
    assert!(!v.in_arrears);
    assert!(v.eligible);

    // The attached funds are held by the contract until the next epoch's
    // deposit leg sweeps them into vault principal.
    let bal = app
        .query::<provwasm_std::types::cosmos::bank::v1beta1::QueryBalanceRequest, provwasm_std::types::cosmos::bank::v1beta1::QueryBalanceResponse>(
            "/cosmos.bank.v1beta1.Query/Balance",
            &provwasm_std::types::cosmos::bank::v1beta1::QueryBalanceRequest {
                address: contract.to_string(),
                denom: FUNDING_DENOM.to_string(),
            },
        )
        .unwrap();
    assert_eq!(bal.balance.unwrap().amount, "155");
}

#[test]
fn halted_contract_rejects_cranks() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let wasm = Wasm::new(&app);

    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::SetHalted { halted: true },
        &[],
        &admin,
    )
    .unwrap();
    let err = wasm
        .execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap_err();
    assert!(format!("{err:?}").contains("halted"));

    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::SetHalted { halted: false },
        &[],
        &admin,
    )
    .unwrap();
    wasm.execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap();
}

/// The authoritative calendar-month gate coverage against the embedded chain:
/// a crank rolls the epoch only once block time enters a strictly later civil
/// month. Time is advanced with `app.increase_time`, so the whole calendar
/// crossing is exercised deterministically and instantly — no wall-clock wait,
/// and no test-only cadence knob (the shipped predicate is what runs here).
#[test]
fn run_epoch_enforces_calendar_month_and_leaves_vault_unpaused() {
    let app = ProvwasmTestApp::new();
    let (admin, vault_address, contract) = base_setup(&app);
    set_asset_manager(&app, &admin, &vault_address, &contract);
    let wasm = Wasm::new(&app);

    // Align the chain clock to just after a month boundary so epoch 1 lands
    // early in a calendar month, leaving a full month of headroom before the
    // boundary the same-month retry must NOT cross.
    let now = app.get_block_time_seconds() as u64;
    let boundary =
        crate::month::first_of_next_month_secs(cosmwasm_std::Timestamp::from_seconds(now));
    app.increase_time(boundary - now + 10);

    // Epoch 1: block time is in a later civil month than the genesis last_run,
    // so the crank runs and leaves the vault unpaused.
    wasm.execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap();
    assert!(!query_vault(&app, &vault_address).vault.unwrap().paused);

    // A second crank in the SAME calendar month is rejected — the gate is a
    // calendar boundary, not an elapsed-time floor.
    let err = wasm
        .execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap_err();
    assert!(format!("{err:?}").contains("too soon"));

    // Advance past the next month boundary (32 days clears any month length);
    // the crank is eligible again.
    app.increase_time(32 * 86_400);
    wasm.execute(contract.as_str(), &ExecuteMsg::RunEpoch {}, &[], &admin)
        .unwrap();

    let status: EpochStatusResponse = wasm
        .query(contract.as_str(), &QueryMsg::EpochStatus {})
        .unwrap();
    assert_eq!(status.phase, "Idle");
    assert!(status.pending_delegations.is_empty());
    assert_eq!(status.receipt_minted, Uint128::zero());
}

#[test]
fn migrate_restamps_cw2_version_and_rejects_foreign_code() {
    use crate::contract::{migrate, CONTRACT_NAME, CONTRACT_VERSION};
    use crate::msg::MigrateMsg;
    use crate::ContractError;
    use cosmwasm_std::testing::{mock_dependencies, mock_env};

    let mut deps = mock_dependencies();

    // No cw2 record (contract never instantiated): migrate must error, not panic.
    migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err();

    // Migrating from an older version of this contract re-stamps the record
    // and reports the transition; a repeat at the same version still succeeds.
    cw2::set_contract_version(deps.as_mut().storage, CONTRACT_NAME, "0.0.9").unwrap();
    for expected_from in ["0.0.9", CONTRACT_VERSION] {
        let res = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap();
        let attr = |k: &str| {
            res.attributes
                .iter()
                .find(|a| a.key == k)
                .map(|a| a.value.clone())
                .unwrap()
        };
        assert_eq!(attr("action"), "migrate");
        assert_eq!(attr("from_version"), expected_from);
        assert_eq!(attr("to_version"), CONTRACT_VERSION);
        let stored = cw2::get_contract_version(deps.as_mut().storage).unwrap();
        assert_eq!(stored.contract, CONTRACT_NAME);
        assert_eq!(stored.version, CONTRACT_VERSION);
    }

    // A cw2 record naming a different contract is a wrong artifact: rejected.
    cw2::set_contract_version(deps.as_mut().storage, "crates.io:other", "9.9.9").unwrap();
    let err = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err();
    assert_eq!(
        err,
        ContractError::InvalidMigration {
            stored: "crates.io:other".to_string(),
            expected: CONTRACT_NAME.to_string(),
        }
    );
}
