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
mod tests {
    use super::*;
    use cosmwasm_std::Timestamp;

    /// Seconds for a UTC date at 00:00:00, via the internal inverse (no external date crate).
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
        // 2100 is NOT a leap year (divisible by 100, not 400): Feb has 28 days.
        assert_eq!(ymd_from_days(days_from_civil(2100, 2, 28)), (2100, 2, 28));
        assert_eq!(
            ymd_from_days(days_from_civil(2100, 2, 28) + 1),
            (2100, 3, 1)
        );
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
        // The instant is exactly the boundary: eligible at it, not one second before.
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
            // Compare as seconds: Timestamp::from_seconds(next) overflows u64 nanos
            // near the domain top (epoch.rs carries the value as u64 seconds).
            let next = first_of_next_month_secs(t);
            let (ny, nm, nd) = ymd_from_days((next / SECS_PER_DAY) as i64);
            proptest::prop_assert_eq!(nd, 1);
            proptest::prop_assert!((ny, nm) > year_month(t));
        }
    }
}
