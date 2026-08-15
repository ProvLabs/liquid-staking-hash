// ExecuteMsg builders (spec §10.2 build step). One typed builder per contract variant
// (contracts/src/msg.rs ExecuteMsg). Funds are attached only for PayCommission / PayTip.

export type ExecuteMsg =
  | { pause_vault: { reason: string } }
  | { unpause_vault: Record<string, never> }
  | { update_config: UpdateConfigFields }
  | { set_halted: { halted: boolean } }
  | { clear_pending_delegations: Record<string, never> }
  | { register_participation: { valoper: string } }
  | { unregister_participation: { valoper: string } }
  | { report_jailed_validator: { valoper: string } }
  | { purge_jailed_validator: { valoper: string; claimant_valoper: string | null } }
  | { pay_commission: { valoper: string } }
  | { pay_tip: { valoper: string } }
  | { capture_uptime_signal: Record<string, never> }
  | { claim_rewards: Record<string, never> }
  | { service_redemptions: Record<string, never> }
  | { run_epoch: Record<string, never> };

export interface UpdateConfigFields {
  max_delegations_per_run?: number | null;
  aum_fee_bps?: number | null;
  performance_threshold_bps?: number | null;
  min_capture_interval_secs?: number | null;
  max_concentration_multiple_bps?: number | null;
  min_bonded_cap_bps?: number | null;
  max_bonded_cap_bps?: number | null;
  concentration_safety_offset_bps?: number | null;
  commission_bps?: number | null;
  jail_unbond_delay_secs?: number | null;
  redemption_margin_bps?: number | null;
}

export const msg = {
  runEpoch: (): ExecuteMsg => ({ run_epoch: {} }),
  claimRewards: (): ExecuteMsg => ({ claim_rewards: {} }),
  serviceRedemptions: (): ExecuteMsg => ({ service_redemptions: {} }),
  captureUptime: (): ExecuteMsg => ({ capture_uptime_signal: {} }),
  reportJailed: (valoper: string): ExecuteMsg => ({ report_jailed_validator: { valoper } }),
  purgeJailed: (valoper: string, claimant: string | null): ExecuteMsg => ({
    purge_jailed_validator: { valoper, claimant_valoper: claimant },
  }),
  payCommission: (valoper: string): ExecuteMsg => ({ pay_commission: { valoper } }),
  payTip: (valoper: string): ExecuteMsg => ({ pay_tip: { valoper } }),
  register: (valoper: string): ExecuteMsg => ({ register_participation: { valoper } }),
  unregister: (valoper: string): ExecuteMsg => ({ unregister_participation: { valoper } }),
  updateConfig: (fields: UpdateConfigFields): ExecuteMsg => ({ update_config: fields }),
  setHalted: (halted: boolean): ExecuteMsg => ({ set_halted: { halted } }),
  clearPending: (): ExecuteMsg => ({ clear_pending_delegations: {} }),
  pauseVault: (reason: string): ExecuteMsg => ({ pause_vault: { reason } }),
  unpauseVault: (): ExecuteMsg => ({ unpause_vault: {} }),
};
