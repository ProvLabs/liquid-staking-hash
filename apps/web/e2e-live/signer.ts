// The signer lives in e2e/support/signer.ts; re-exported so the live specs'
// import paths and the check:bundle sentinel scan stay unchanged.

export { bech32Encode, DevnetTestSigner, TEST_SIGNER_SENTINEL } from "../e2e/support/signer";
