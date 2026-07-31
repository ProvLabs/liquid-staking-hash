//! Long-running chain-free simulation soak (RC2 §15.5). Runs randomized
//! multi-decade scenarios through the production planners indefinitely,
//! asserting the invariant battery every simulated epoch and reporting
//! periodically. Leave it running for minutes or days; every violation is
//! printed with its scenario seed (and appended to sim-failures.log) so
//! `--seed N --scenarios 1` reproduces it exactly.
//!
//! Usage:
//!   cargo run --release --bin simulate -- [--seed N] [--scenarios N]
//!       [--epochs N] [--report-secs N] [--halt-on-failure] [--trace-out DIR]
//!
//! Defaults: random master seed, unbounded scenarios, 240 epochs (20 years,
//! monthly) per scenario, a status line every 10 seconds. `--trace-out DIR`
//! writes one `seed-<scenario_seed>.json` deposit/redemption/epoch trace per
//! scenario into DIR; omit it for today's behavior.

use std::io::Write;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use nvhash_staking::sim::{run_scenario, run_scenario_traced, Scenario, Stats};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let master_seed: u64 = arg("--seed")
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64
        });
    let max_scenarios: u64 = arg("--scenarios").and_then(|v| v.parse().ok()).unwrap_or(0);
    let epochs: u32 = arg("--epochs").and_then(|v| v.parse().ok()).unwrap_or(240);
    let report_secs: u64 = arg("--report-secs")
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let halt = std::env::args().any(|a| a == "--halt-on-failure");
    let trace_out = arg("--trace-out");
    if let Some(dir) = &trace_out {
        std::fs::create_dir_all(dir).expect("create --trace-out directory");
    }

    println!("nvHASH chain-free simulation soak (RC2 15.5)");
    println!("  master seed  : {master_seed}   (reproduce a scenario: --seed <scenario_seed> --scenarios 1)");
    println!(
        "  scenarios    : {}",
        if max_scenarios == 0 {
            "unbounded".to_string()
        } else {
            max_scenarios.to_string()
        }
    );
    println!(
        "  epochs each  : {epochs} ({} simulated years, monthly)",
        epochs / 12
    );
    println!("  reporting    : every {report_secs}s; failures also appended to sim-failures.log");
    println!();

    let start = Instant::now();
    let mut last_report = Instant::now();
    let mut agg = Stats::default();
    let mut scenarios = 0u64;
    let mut failures = 0u64;

    loop {
        if max_scenarios > 0 && scenarios >= max_scenarios {
            break;
        }
        let scenario_seed = master_seed.wrapping_add(scenarios.wrapping_mul(0x9E3779B97F4A7C15));
        let sc = Scenario::from_seed(scenario_seed, epochs);
        let result = if let Some(dir) = &trace_out {
            let (result, trace) = run_scenario_traced(sc.clone());
            let path = format!("{dir}/seed-{scenario_seed}.json");
            let json = serde_json::to_string_pretty(&trace).expect("serialize trace");
            std::fs::write(&path, json + "\n").expect("write trace file");
            result
        } else {
            run_scenario(sc.clone())
        };
        scenarios += 1;
        agg.epochs += result.stats.epochs;
        agg.checks += result.stats.checks;
        agg.deposits += result.stats.deposits;
        agg.redemptions_paid += result.stats.redemptions_paid;
        agg.redemption_refunds += result.stats.redemption_refunds;
        agg.slashes += result.stats.slashes;
        agg.write_downs += result.stats.write_downs;
        agg.redelegations += result.stats.redelegations;
        agg.fee_starved_steps += result.stats.fee_starved_steps;
        agg.max_tvv = agg.max_tvv.max(result.stats.max_tvv);
        agg.worst_convergence_dev = agg
            .worst_convergence_dev
            .max(result.stats.worst_convergence_dev);

        if !result.violations.is_empty() {
            failures += 1;
            eprintln!("\nVIOLATIONS in scenario seed {scenario_seed} ({:?}):", sc);
            for v in &result.violations {
                eprintln!("  {v}");
            }
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open("sim-failures.log")
            {
                let _ = writeln!(f, "seed {scenario_seed} config {sc:?}");
                for v in &result.violations {
                    let _ = writeln!(f, "  {v}");
                }
            }
            if halt {
                eprintln!("\nhalting on first failure (--halt-on-failure)");
                std::process::exit(1);
            }
        }

        if last_report.elapsed().as_secs() >= report_secs {
            last_report = Instant::now();
            let el = start.elapsed().as_secs().max(1);
            println!(
                "[{:>6}s] scenarios {:>7} | epochs {:>10} ({}/s) | checks {:>12} | failures {} | deposits {} redeemed {} refunds {} | slashes {} write-downs {} redelegations {} | fee-starved steps {} | worst convergence dev {} | max TVL {:.3e}",
                el,
                scenarios,
                agg.epochs,
                agg.epochs / el,
                agg.checks,
                failures,
                agg.deposits,
                agg.redemptions_paid,
                agg.redemption_refunds,
                agg.slashes,
                agg.write_downs,
                agg.redelegations,
                agg.fee_starved_steps,
                agg.worst_convergence_dev,
                agg.max_tvv as f64,
            );
        }
    }

    let el = start.elapsed().as_secs().max(1);
    println!("\ndone: {scenarios} scenarios, {} epochs, {} checks, {failures} failing scenarios in {el}s", agg.epochs, agg.checks);
    std::process::exit(if failures > 0 { 1 } else { 0 });
}
