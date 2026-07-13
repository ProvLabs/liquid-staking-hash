//! Local shim for the vault module's AcceptAsset message, which is newer than the
//! provwasm-std 2.8.0 generated types.
//!
//! Reconciled against ProvLabs/vault main proto/provlabs/vault/v1/tx.proto on
//! 2026-07-08: field names, tags, and the type URL match MsgAcceptAssetRequest
//! exactly (authority=1, vault_address=2, source=3, external_id=4, all strings;
//! signer = authority). The proto also confirms the payment's TARGET must be the
//! vault address (not the principal marker), and that the vault settles only
//! payments where one leg carries the vault's payment denom (nhash in Design C).
//! Remaining [VERIFY] is runtime-only, on the devnet drill: that the deployed
//! chain build ships this message and that settlement clears the restricted
//! receipt marker's send restrictions into the principal marker.

use cosmwasm_std::{AnyMsg, Binary, CosmosMsg};
use prost::Message;

pub const ACCEPT_ASSET_TYPE_URL: &str = "/provlabs.vault.v1.MsgAcceptAssetRequest";

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgAcceptAssetRequest {
    /// The vault's asset manager authorizing the settlement; this contract.
    #[prost(string, tag = "1")]
    pub authority: ::prost::alloc::string::String,
    /// The vault settling the payment (must be the payment's target).
    #[prost(string, tag = "2")]
    pub vault_address: ::prost::alloc::string::String,
    /// The account that created the pending exchange payment.
    #[prost(string, tag = "3")]
    pub source: ::prost::alloc::string::String,
    /// Together with source, uniquely identifies the pending payment.
    #[prost(string, tag = "4")]
    pub external_id: ::prost::alloc::string::String,
}

pub fn accept_asset_msg(
    authority: &str,
    vault_address: &str,
    source: &str,
    external_id: &str,
) -> CosmosMsg {
    let msg = MsgAcceptAssetRequest {
        authority: authority.to_string(),
        vault_address: vault_address.to_string(),
        source: source.to_string(),
        external_id: external_id.to_string(),
    };
    CosmosMsg::Any(AnyMsg {
        type_url: ACCEPT_ASSET_TYPE_URL.to_string(),
        value: Binary::from(msg.encode_to_vec()),
    })
}

pub const UPDATE_VAULT_NAV_TYPE_URL: &str = "/provlabs.vault.v1.MsgUpdateVaultNAVRequest";

/// Shim for the vault's UpdateVaultNAV message (also newer than provwasm-std
/// 2.8.0). Reconciled against ProvLabs/vault main tx.proto 2026-07-09:
/// signer=1, vault_address=2, denom=3, price=4 (Coin), volume=5 (Int string),
/// source=6; signer = the vault's NAV authority. Used by the slash write-down
/// "guardrail sandwich" (see epoch.rs): the contract must be rotated in as the
/// vault's NAV authority at bootstrap (tx vault update-nav-authority).
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgUpdateVaultNavRequest {
    #[prost(string, tag = "1")]
    pub signer: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub vault_address: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub denom: ::prost::alloc::string::String,
    #[prost(message, optional, tag = "4")]
    pub price: ::core::option::Option<provwasm_std::types::cosmos::base::v1beta1::Coin>,
    #[prost(string, tag = "5")]
    pub volume: ::prost::alloc::string::String,
    #[prost(string, tag = "6")]
    pub source: ::prost::alloc::string::String,
}

pub fn update_vault_nav_msg(
    signer: &str,
    vault_address: &str,
    denom: &str,
    price_denom: &str,
    price_amount: u128,
    volume: u128,
    source: &str,
) -> CosmosMsg {
    let msg = MsgUpdateVaultNavRequest {
        signer: signer.to_string(),
        vault_address: vault_address.to_string(),
        denom: denom.to_string(),
        price: Some(provwasm_std::types::cosmos::base::v1beta1::Coin {
            denom: price_denom.to_string(),
            amount: price_amount.to_string(),
        }),
        volume: volume.to_string(),
        source: source.to_string(),
    };
    CosmosMsg::Any(AnyMsg {
        type_url: UPDATE_VAULT_NAV_TYPE_URL.to_string(),
        value: Binary::from(msg.encode_to_vec()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards this seam against silent tag/field regressions: builds the
    /// message, confirms it is wrapped as a CosmosMsg::Any with the expected type
    /// URL, then prost-decodes the value bytes back into MsgAcceptAssetRequest and
    /// checks every field survived the round trip.
    #[test]
    fn accept_asset_msg_round_trips_through_prost() {
        let msg = accept_asset_msg(
            "contract1authority",
            "vault1address",
            "contract1source",
            "nvhash.deploy",
        );

        let any = match msg {
            CosmosMsg::Any(any) => any,
            other => panic!("expected CosmosMsg::Any, got {other:?}"),
        };
        assert_eq!(any.type_url, ACCEPT_ASSET_TYPE_URL);

        let decoded = MsgAcceptAssetRequest::decode(any.value.as_slice())
            .expect("value bytes must decode as MsgAcceptAssetRequest");
        assert_eq!(decoded.authority, "contract1authority");
        assert_eq!(decoded.vault_address, "vault1address");
        assert_eq!(decoded.source, "contract1source");
        assert_eq!(decoded.external_id, "nvhash.deploy");
    }

    #[test]
    fn update_vault_nav_msg_round_trips_through_prost() {
        let msg = update_vault_nav_msg(
            "contract1signer",
            "vault1address",
            "nvhash.staked",
            "nhash",
            0,
            12_345,
            "nvhash-writedown",
        );
        let any = match msg {
            CosmosMsg::Any(any) => any,
            other => panic!("expected CosmosMsg::Any, got {other:?}"),
        };
        assert_eq!(any.type_url, UPDATE_VAULT_NAV_TYPE_URL);
        let decoded = MsgUpdateVaultNavRequest::decode(any.value.as_slice()).unwrap();
        assert_eq!(decoded.signer, "contract1signer");
        assert_eq!(decoded.vault_address, "vault1address");
        assert_eq!(decoded.denom, "nvhash.staked");
        let price = decoded.price.unwrap();
        assert_eq!(price.denom, "nhash");
        assert_eq!(price.amount, "0");
        assert_eq!(decoded.volume, "12345");
        assert_eq!(decoded.source, "nvhash-writedown");
    }
}
