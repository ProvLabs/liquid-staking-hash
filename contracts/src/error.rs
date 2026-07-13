use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized")]
    Unauthorized {},

    #[error("halted: cranks are disabled by the admin")]
    Halted {},

    #[error("too soon: next run allowed at {next}")]
    TooSoon { next: u64 },

    #[error("invalid valoper address: {valoper}")]
    InvalidValoper { valoper: String },

    #[error("caller is not the operator of {valoper}")]
    NotOperator { valoper: String },

    #[error("validator already enrolled: {valoper}")]
    AlreadyEnrolled { valoper: String },

    #[error("validator not enrolled: {valoper}")]
    NotEnrolled { valoper: String },

    #[error("validator not found on chain: {valoper}")]
    ValidatorNotFound { valoper: String },

    #[error("too many validators: max {max}")]
    TooManyValidators { max: u32 },

    #[error("validator is not jailed: {valoper}")]
    NotJailed { valoper: String },

    #[error("no jail report on file for {valoper}: call report_jailed_validator first")]
    JailReportMissing { valoper: String },

    #[error("jail cooldown active: purge allowed at {ready}")]
    JailCooldownActive { ready: u64 },

    #[error("claimant not eligible: {valoper}")]
    ClaimantNotEligible { valoper: String },

    #[error("unbonding entries full for {valoper}: retry after entries mature")]
    UnbondEntriesFull { valoper: String },
}
