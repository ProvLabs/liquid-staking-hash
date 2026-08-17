export const MOCK_IDENTITIES: { label: string; address: string }[] = [
  { label: "admin (Ada)", address: "pb1adminadminadminadminadminadminadmin00" },
  { label: "operator (Pat)", address: "pb1operatoroperatoroperatoroperatorop000" },
  { label: "keeper (Kai)", address: "pb1keeperkeeperkeeperkeeperkeeperkeep0000" },
];

/** Deterministic (no Math.random) fake hash for mock txids. */
export function mockTxHash(payload: string): string {
  let h = 0;
  for (let i = 0; i < payload.length; i++) h = (h << 5) - h + payload.charCodeAt(i);
  return `MOCK${Math.abs(h).toString(16).toUpperCase()}`;
}
