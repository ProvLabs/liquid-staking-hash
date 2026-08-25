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
