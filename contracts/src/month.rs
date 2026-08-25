//! Calendar-month arithmetic on consensus block time: `RunEpoch` eligibility is a strictly
//! later `(year, month)` than the last run, derived from `env.block.time` via the integer
//! days-from-civil algorithm (H. Hinnant). Total and panic-free over the u64 nanosecond domain.

use cosmwasm_std::Timestamp;

/// Nominal 30-day epoch length sizing the AUM fee-reserve horizon and deploy buffer (`epoch.rs`).
pub const NOMINAL_EPOCH_SECS: u64 = 2_592_000; // 30 days

const SECS_PER_DAY: u64 = 86_400;

/// The UTC calendar `(year, month)` of a block time; `month` is `1..=12`.
/// Eligibility is the tuple comparison `year_month(now) > year_month(last_run)`.
pub fn year_month(t: Timestamp) -> (i32, u32) {
    let (y, m, _) = ymd_from_days((t.seconds() / SECS_PER_DAY) as i64);
    (y, m)
}

/// First Unix second of the month after `t`'s calendar month: the earliest instant the
/// next epoch is eligible (the `TooSoon { next }` payload).
pub fn first_of_next_month_secs(t: Timestamp) -> u64 {
    let (y, m, _) = ymd_from_days((t.seconds() / SECS_PER_DAY) as i64);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) as u64) * SECS_PER_DAY
}

/// Days since 1970-01-01 to `(year, month, day)`, `month`/`day` 1-based. Exact integer
/// days-from-civil inverse; the 400/100/4 century leap rule is folded into the era math.
fn ymd_from_days(z: i64) -> (i32, u32, u32) {
    // Shift the epoch to 0000-03-01 so leap days fall at the end of the cycle.
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // day of era [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year [0, 365]
    let mp = (5 * doy + 2) / 153; // month, shifted so March = 0 [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

/// `(year, month, day)` to days since 1970-01-01; inverse of [`ymd_from_days`], 1-based.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let m = m as i64;
    let d = d as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146_096]
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests;
