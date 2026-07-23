// POST /tx/simulate (PR 5.2, §10.2 step 3): price the intent's gas for the
// SESSION address. The intent is constructed server-side from the session
// address and the configured vault — the client chooses only kind, amount,
// and its pubkey; it cannot name another owner or vault.

import { z } from "zod";

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import { AuthClient, LcdClient } from "@nvhash/chain-client";
import type { TxIntent } from "~/tx/build";
import { simulateIntent } from "~/tx/simulate.server";
import type { Route } from "./+types/tx-simulate";

const bodySchema = z.object({
  kind: z.enum(["swap_in", "swap_out"]),
  amount: z.string().regex(/^[0-9]{1,39}$/),
  denom: z.string().min(1).max(64),
  /** base64 33-byte compressed secp256k1 from the connected wallet. */
  pubkey: z.string().length(44).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  redeemDenom: z.string().max(64).default(""),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const lcd = new LcdClient(config.lcdUrl);
  const account = await new AuthClient(lcd).account(session.address);
  if (account === null) {
    return Response.json({ error: "account not on chain" }, { status: 409 });
  }
  const signer = {
    chainId: config.chainId,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    pubkeyBase64: body.pubkey,
  };
  const intent: TxIntent =
    body.kind === "swap_in"
      ? {
          kind: "swap_in",
          owner: session.address,
          vaultAddress: config.vaultAddress,
          amount: BigInt(body.amount),
          denom: body.denom,
        }
      : {
          kind: "swap_out",
          owner: session.address,
          vaultAddress: config.vaultAddress,
          amount: BigInt(body.amount),
          denom: body.denom,
          redeemDenom: body.redeemDenom,
        };
  try {
    const result = await simulateIntent(config, intent, signer);
    return Response.json({
      gas_used: result.gasUsed,
      fee: {
        gas_limit: result.fee.gasLimit.toString(),
        amount: result.fee.amount.toString(),
        denom: result.fee.denom,
      },
      signer: {
        account_number: signer.accountNumber.toString(),
        sequence: signer.sequence.toString(),
        chain_id: signer.chainId,
      },
    });
  } catch (error) {
    // Simulation failure is a would-fail surfaced BEFORE signing — an
    // honest 422 with the chain's reason, never a pass-through to sign.
    return Response.json(
      { error: "simulation failed", detail: error instanceof Error ? error.message : "unknown" },
      { status: 422 },
    );
  }
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
