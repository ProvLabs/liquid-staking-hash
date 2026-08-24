//! Hand-rolled `AcceptAsset` and `UpdateVaultNAV` shims that provwasm-std 2.8.0 predates,
//! reconciled against the ProvLabs/vault v1.2.4 protos; the round-trip tests pin every field
//! and tag. Deletable once a provwasm-std release generates types for vault v1.2.4+.

use cosmwasm_std::{AnyMsg, Binary, CosmosMsg};
use prost::Message;
use provwasm_std::types::cosmos::base::v1beta1::Coin as ProstCoin;

/// The vault module's x/exchange payment (vault.proto `Payment`); field numbers match
/// `provenance.exchange.v1.Payment` so both legs encode identically.
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Payment {
    /// The account that created the payment and owns the escrowed source_amount.
    #[prost(string, tag = "1")]
    pub source: ::prost::alloc::string::String,
    /// What the source pays the target.
    #[prost(message, repeated, tag = "2")]
    pub source_amount: ::prost::alloc::vec::Vec<ProstCoin>,
    /// The account that can accept the payment; the vault, for settlements.
    #[prost(string, tag = "3")]
    pub target: ::prost::alloc::string::String,
    /// What the target pays the source in exchange for source_amount.
    #[prost(message, repeated, tag = "4")]
    pub target_amount: ::prost::alloc::vec::Vec<ProstCoin>,
    /// Together with source, uniquely identifies the payment.
    #[prost(string, tag = "5")]
    pub external_id: ::prost::alloc::string::String,
}

pub const ACCEPT_ASSET_TYPE_URL: &str = "/provlabs.vault.v1.MsgAcceptAssetRequest";

/// Settles a pending x/exchange payment whose target is the vault. Tags 3 and 4 are
/// reserved upstream (retired `source` / `external_id`); never reuse them.
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgAcceptAssetRequest {
    /// The vault's asset manager authorizing the settlement; this contract.
    #[prost(string, tag = "1")]
    pub authority: ::prost::alloc::string::String,
    /// The vault settling the payment (must be the payment's target).
    #[prost(string, tag = "2")]
    pub vault_address: ::prost::alloc::string::String,
    /// Full terms approved; settlement fails if any field differs from the pending payment.
    #[prost(message, optional, tag = "5")]
    pub payment: ::core::option::Option<Payment>,
}

/// Builds the settlement approval for a payment this contract sourced. The payment target
/// is forced to `vault_address` (the vault rejects any other target); the remaining
/// arguments must reproduce the pending payment's terms exactly.
pub fn accept_asset_msg(
    authority: &str,
    vault_address: &str,
    source: &str,
    source_amount: Vec<ProstCoin>,
    target_amount: Vec<ProstCoin>,
    external_id: &str,
) -> CosmosMsg {
    let msg = MsgAcceptAssetRequest {
        authority: authority.to_string(),
        vault_address: vault_address.to_string(),
        payment: Some(Payment {
            source: source.to_string(),
            source_amount,
            target: vault_address.to_string(),
            target_amount,
            external_id: external_id.to_string(),
        }),
    };
    CosmosMsg::Any(AnyMsg {
        type_url: ACCEPT_ASSET_TYPE_URL.to_string(),
        value: Binary::from(msg.encode_to_vec()),
    })
}

pub const UPDATE_VAULT_NAV_TYPE_URL: &str = "/provlabs.vault.v1.MsgUpdateVaultNAVRequest";

/// Creates or updates one internal NAV entry; `signer` is the vault's NAV authority
/// (rotated to this contract at bootstrap). Repricing a HELD denom requires a paused vault;
/// unheld or same-price restatement is allowed live (v1.2.4 keeper/nav.go).
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgUpdateVaultNavRequest {
    #[prost(string, tag = "1")]
    pub signer: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub vault_address: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub denom: ::prost::alloc::string::String,
    #[prost(message, optional, tag = "4")]
    pub price: ::core::option::Option<ProstCoin>,
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
        price: Some(ProstCoin {
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

    fn coin(denom: &str, amount: u128) -> ProstCoin {
        ProstCoin {
            denom: denom.to_string(),
            amount: amount.to_string(),
        }
    }

    /// Guards the seam against silent tag/field regressions: checks the Any type URL and
    /// prost-decodes the bytes, verifying every field (payment legs included) round-trips.
    #[test]
    fn accept_asset_msg_round_trips_through_prost() {
        let msg = accept_asset_msg(
            "contract1authority",
            "vault1address",
            "contract1source",
            vec![coin("nvhash.staked", 500)],
            vec![coin("nhash", 500)],
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
        let payment = decoded.payment.expect("payment is always carried");
        assert_eq!(payment.source, "contract1source");
        assert_eq!(payment.source_amount, vec![coin("nvhash.staked", 500)]);
        assert_eq!(payment.target_amount, vec![coin("nhash", 500)]);
        assert_eq!(payment.external_id, "nvhash.deploy");
    }

    /// The vault rejects a settlement whose payment target is not the vault, so
    /// the builder sets it from vault_address rather than from a caller argument.
    #[test]
    fn accept_asset_payment_target_is_the_vault() {
        let msg = accept_asset_msg(
            "contract1authority",
            "vault1address",
            "contract1source",
            vec![],
            vec![coin("nvhash.staked", 200)],
            "nvhash.writedown",
        );
        let CosmosMsg::Any(any) = msg else {
            panic!("expected CosmosMsg::Any")
        };
        let decoded = MsgAcceptAssetRequest::decode(any.value.as_slice()).unwrap();
        let payment = decoded.payment.unwrap();
        assert_eq!(payment.target, "vault1address");
        // A zero-priced extraction carries no source leg.
        assert!(payment.source_amount.is_empty());
    }

    /// Tags 3 and 4 are reserved upstream; an encoded approval must carry neither.
    #[test]
    fn accept_asset_msg_emits_no_reserved_tags() {
        let msg = accept_asset_msg(
            "contract1authority",
            "vault1address",
            "contract1source",
            vec![coin("nhash", 1)],
            vec![coin("nvhash.staked", 1)],
            "nvhash.return",
        );
        let CosmosMsg::Any(any) = msg else {
            panic!("expected CosmosMsg::Any")
        };
        // Protobuf keys are (tag << 3) | wire_type; assert no encoded tag is 3 or 4.
        let mut buf = any.value.as_slice();
        let mut tags = vec![];
        while !buf.is_empty() {
            let key = prost::encoding::decode_varint(&mut buf).expect("valid key");
            let tag = (key >> 3) as u32;
            let wire_type = prost::encoding::WireType::try_from(key & 0x07).expect("valid wire");
            tags.push(tag);
            prost::encoding::skip_field(
                wire_type,
                tag,
                &mut buf,
                prost::encoding::DecodeContext::default(),
            )
            .expect("skippable field");
        }
        assert_eq!(
            tags,
            vec![1, 2, 5],
            "reserved tags 3/4 must never be emitted"
        );
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
