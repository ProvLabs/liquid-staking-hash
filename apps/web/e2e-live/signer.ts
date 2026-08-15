// The test signer lives in e2e/support/signer.ts since PR 8.3 (the offline
// suite fabricates sessions through the app's own login path too, so the
// signer is shared test support). Re-exported here so the live specs' import
// paths — and the check:bundle sentinel scan's subject — are unchanged.

export { bech32Encode, DevnetTestSigner, TEST_SIGNER_SENTINEL } from "../e2e/support/signer";
