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
