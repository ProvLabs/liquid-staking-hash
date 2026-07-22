//! Calendar-month arithmetic on consensus block time.
//!
//! `RunEpoch` eligibility is a calendar-month rollover: the next run is allowed
//! once block time is in a strictly later `(year, month)` than the last run
//! (`liquid-staking-spec.md` §9). The contract only ever receives block time as
//! `env.block.time` — nanoseconds since the Unix epoch — never the header's
//! civil date string, so the `(year, month)` the comparison needs is derived
//! here with a small, dependency-free integer conversion (the days-from-civil
//! algorithm; H. Hinnant, "chrono-Compatible Low-Level Date Algorithms"). No
//! external calendar crate, no floats, total and panic-free over the whole
//! `u64` nanosecond domain: `Timestamp::seconds()` is at most `u64::MAX / 1e9`
//! (~1.8e10s ≈ 213_500 days ≈ year 2554), so every intermediate stays small and
//! well within `i64`.

use cosmwasm_std::Timestamp;

/// Nominal epoch length used to size the AUM fee-reserve horizon now that
/// `min_run_interval_secs` is retired. Calendar months are 28–31 days; 30 days
/// is the mid-point the two-epoch deploy buffer is sized against (`epoch.rs`).
pub const NOMINAL_EPOCH_SECS: u64 = 2_592_000; // 30 days

const SECS_PER_DAY: u64 = 86_400;

/// The calendar `(year, month)` of a block time (UTC, from consensus seconds).
///
/// Eligibility is the plain tuple comparison
/// `year_month(now) > year_month(last_run)` — a later year, or the same year and
/// a later month. `month` is `1..=12`.
pub fn year_month(t: Timestamp) -> (i32, u32) {
    let (y, m, _) = ymd_from_days((t.seconds() / SECS_PER_DAY) as i64);
    (y, m)
}

/// First Unix second of the month *after* `t`'s calendar month — i.e. the
/// earliest instant at which the next epoch becomes eligible. Used for the
/// `TooSoon { next }` payload.
pub fn first_of_next_month_secs(t: Timestamp) -> u64 {
    let (y, m, _) = ymd_from_days((t.seconds() / SECS_PER_DAY) as i64);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) as u64) * SECS_PER_DAY
}

/// Days since 1970-01-01 → `(year, month, day)`, `month`/`day` 1-based.
///
/// The days-from-civil inverse: exact integer arithmetic, no leap-year special
/// cases at the call site (the 400/100/4-year cycle is folded into the era
/// math, so the 2000-leap / 2100-non-leap century rule is handled). Total for
/// every `i64` input in the block-time-derived range.
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

/// `(year, month, day)` → days since 1970-01-01. Inverse of [`ymd_from_days`];
/// `month`/`day` 1-based. Used only with in-range civil dates (month starts).
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
mod tests {
    use super::*;
    use cosmwasm_std::Timestamp;

    /// Seconds for a UTC calendar date at 00:00:00 (via the internal inverse, so
    /// the test does not depend on an external date library).
    fn secs(y: i32, m: u32, d: u32) -> u64 {
        (days_from_civil(y, m, d) as u64) * SECS_PER_DAY
    }

    fn ym(y: i32, m: u32, d: u32) -> (i32, u32) {
        year_month(Timestamp::from_seconds(secs(y, m, d)))
    }

    #[test]
    fn round_trips_across_month_lengths_and_leaps() {
        // 1970 epoch anchor, month lengths, and leap-year Feb boundaries.
        assert_eq!(ymd_from_days(0), (1970, 1, 1));
        assert_eq!(ym(1970, 1, 1), (1970, 1));
        assert_eq!(ym(2026, 7, 22), (2026, 7));
        // 31-day month end / next-month start.
        assert_eq!(ym(2026, 1, 31), (2026, 1));
        assert_eq!(ym(2026, 2, 1), (2026, 2));
        // Feb 28 vs 29 in a leap year (2024), and non-leap (2026).
        assert_eq!(ym(2024, 2, 29), (2024, 2));
        assert_eq!(ym(2024, 3, 1), (2024, 3));
        assert_eq!(ym(2026, 2, 28), (2026, 2));
        assert_eq!(ym(2026, 3, 1), (2026, 3));
    }

    #[test]
    fn century_leap_rule() {
        // 2000 is a leap year (divisible by 400): Feb 29 exists.
        assert_eq!(ym(2000, 2, 29), (2000, 2));
        assert_eq!(ym(2000, 3, 1), (2000, 3));
        // 2100 is NOT a leap year (divisible by 100, not 400): Feb has 28 days,
        // so "day 60" of 2100 is March 1, not Feb 29.
        assert_eq!(ymd_from_days(days_from_civil(2100, 2, 28)), (2100, 2, 28));
        assert_eq!(ymd_from_days(days_from_civil(2100, 2, 28) + 1), (2100, 3, 1));
    }

    #[test]
    fn year_rollover() {
        assert_eq!(ym(2026, 12, 31), (2026, 12));
        assert_eq!(ym(2027, 1, 1), (2027, 1));
    }

    #[test]
    fn eligibility_is_strict_later_month() {
        let dec = year_month(Timestamp::from_seconds(secs(2026, 12, 15)));
        let jan = year_month(Timestamp::from_seconds(secs(2027, 1, 1)));
        let dec_late = year_month(Timestamp::from_seconds(secs(2026, 12, 31)));
        // Same month (even much later in the month) is NOT eligible.
        assert!(!(dec_late > dec));
        // A later month, across a year boundary, IS eligible.
        assert!(jan > dec);
    }

    #[test]
    fn first_of_next_month_is_the_eligibility_instant() {
        // Mid-January → first second of February.
        let t = Timestamp::from_seconds(secs(2026, 1, 15));
        assert_eq!(first_of_next_month_secs(t), secs(2026, 2, 1));
        // December → next January (year rollover).
        let t = Timestamp::from_seconds(secs(2026, 12, 9));
        assert_eq!(first_of_next_month_secs(t), secs(2027, 1, 1));
        // Leap February → March.
        let t = Timestamp::from_seconds(secs(2024, 2, 29));
        assert_eq!(first_of_next_month_secs(t), secs(2024, 3, 1));
        // The returned instant is exactly the boundary: at it we are eligible,
        // one second before it we are not.
        let boundary = first_of_next_month_secs(t);
        assert!(year_month(Timestamp::from_seconds(boundary)) > year_month(t));
        assert!(!(year_month(Timestamp::from_seconds(boundary - 1)) > year_month(t)));
    }

    proptest::proptest! {
        /// Totality: the conversion never panics on any u64 nanosecond value,
        /// and always yields a valid civil month/day.
        #[test]
        fn year_month_is_total_over_u64_nanos(nanos in proptest::num::u64::ANY) {
            let t = Timestamp::from_nanos(nanos);
            let (_y, m) = year_month(t);
            proptest::prop_assert!((1..=12).contains(&m));
            // first_of_next_month is strictly later and lands on a month start.
            let next = first_of_next_month_secs(t);
            let (_ny, _nm, nd) = ymd_from_days((next / SECS_PER_DAY) as i64);
            proptest::prop_assert_eq!(nd, 1);
            proptest::prop_assert!(year_month(Timestamp::from_seconds(next)) > year_month(t));
        }
    }
}
