// POST /tx/simulate (§10.2 step 3): price the intent's gas for the
// SESSION address. The intent is constructed server-side from the session
// address and the configured vault — the client chooses only kind, amount,
// and its pubkey; it cannot name another owner or vault.

import { z } from "zod";

import { getBootedConfig } from "~/config/config.server";
import { describeTemplateError, parseTemplateValues } from "~/governance/templates";
import { VALOPER_RE } from "~/lib/bech32";
import { requireSession } from "~/lib/services/session.server";
import { governancePreflightRequestSchema } from "~/tx/preflight.server";
import { AuthClient, LcdClient } from "@nvhash/chain-client";
import {
  FUNDED_VARIANTS,
  OPERATOR_VARIANTS,
  PROGRAM_UNDERLYING_DENOM,
  type TxIntent,
} from "~/tx/build";
import { simulateIntent } from "~/tx/simulate.server";
import type { Route } from "./+types/tx-simulate";

/** base64 33-byte compressed secp256k1 from the connected wallet. */
const pubkeySchema = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const valoperSchema = z.string().max(90).regex(VALOPER_RE);

const bodySchema = z.object({
  kind: z.enum(["swap_in", "swap_out"]),
  amount: z.string().regex(/^[0-9]{1,39}$/),
  denom: z.string().min(1).max(64),
  pubkey: pubkeySchema,
  redeemDenom: z.string().max(64).default(""),
});

/** Operator actions: a separate bounded schema, never a widened one. The
 * client chooses the variant, its validator and the amount; the SENDER and the
 * CONTRACT are filled server-side, so it cannot name another signer or a
 * different contract. */
const operatorBodySchema = z
  .object({
    kind: z.literal("operator"),
    variant: z.enum(OPERATOR_VARIANTS),
    valoper: valoperSchema,
    claimantValoper: valoperSchema.nullable().default(null),
    amount: z
      .string()
      .regex(/^[0-9]{1,39}$/)
      .default("0"),
    denom: z.string().min(1).max(64).default(PROGRAM_UNDERLYING_DENOM),
    pubkey: pubkeySchema,
  })
  // Funds discipline, bounded at the BOUNDARY in both directions — the same
  // rule `guardOperatorExecute` applies at the relay and the encoder now
  // asserts. Rejecting here (400) is what keeps the encoder's throw a backstop
  // rather than a 500: a zero-amount payment, or funds on a fundless action,
  // never reaches the builder (2026-07-28 review).
  .refine(
    (b) => FUNDED_VARIANTS.has(b.variant) === BigInt(b.amount) > 0n,
    "a payment requires a positive amount; every other action must carry none",
  );

/**
 * Governance actions. A third bounded schema, on the same terms as the
 * operator one: the client names the proposal, the option and the template; the
 * SIGNER and the CONTRACT are filled server-side, so it cannot name another
 * voter, another proposer, or a different contract for a proposal's messages.
 *
 * The policy address IS client-supplied — the program has 1..n policies (D1) and
 * only the composer knows which one the user chose — and it is re-checked
 * server-side twice: by preflight against the discovered set, and by the relay
 * guard's condition 3 over the signed bytes.
 */
const governanceBodySchema = z.intersection(
  governancePreflightRequestSchema,
  z.object({ pubkey: pubkeySchema }),
);

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  const payload: unknown = await request.json().catch(() => null);

  const governance = governanceBodySchema.safeParse(payload);
  if (governance.success) {
    return simulateGovernance(config, session.address, governance.data);
  }

  const operator = operatorBodySchema.safeParse(payload);
  const swap = operator.success ? null : bodySchema.safeParse(payload);
  if (!operator.success && (swap === null || !swap.success)) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const pubkey = operator.success ? operator.data.pubkey : swap!.data!.pubkey;

  const lcd = new LcdClient(config.lcdUrl);
  const account = await new AuthClient(lcd).account(session.address);
  if (account === null) {
    return Response.json({ error: "account not on chain" }, { status: 409 });
  }
  const signer = {
    chainId: config.chainId,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    pubkeyBase64: pubkey,
  };
  const intent: TxIntent = operator.success
    ? {
        kind: "operator",
        variant: operator.data.variant,
        sender: session.address,
        contractAddress: config.contractAddress,
        valoper: operator.data.valoper,
        claimantValoper: operator.data.claimantValoper,
        amount: BigInt(operator.data.amount),
        denom: operator.data.denom,
      }
    : swap!.data!.kind === "swap_in"
      ? {
          kind: "swap_in",
          owner: session.address,
          vaultAddress: config.vaultAddress,
          amount: BigInt(swap!.data!.amount),
          denom: swap!.data!.denom,
        }
      : {
          kind: "swap_out",
          owner: session.address,
          vaultAddress: config.vaultAddress,
          amount: BigInt(swap!.data!.amount),
          denom: swap!.data!.denom,
          redeemDenom: swap!.data!.redeemDenom,
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

/**
 * Simulate a governance intent (§2.5 would-fail simulation before sign).
 *
 * A full `MsgExec` simulation EXECUTES the proposal's inner messages in the
 * node's simulation context, which is the intended depth: it is
 * side-effect-free — the node discards the simulated state — and it is the only
 * way to surface "passed, but will fail to execute", which is exactly what
 * the indexer's `executorResult` column exists to make visible. Surfacing that reason
 * BEFORE the wallet is asked to sign is the whole point of §10.2 step 3.
 */
async function simulateGovernance(
  config: Awaited<ReturnType<typeof getBootedConfig>>,
  address: string,
  body: z.infer<typeof governanceBodySchema>,
): Promise<Response> {
  const lcd = new LcdClient(config.lcdUrl);
  const account = await new AuthClient(lcd).account(address);
  if (account === null) {
    return Response.json({ error: "account not on chain" }, { status: 409 });
  }
  const signer = {
    chainId: config.chainId,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    pubkeyBase64: body.pubkey,
  };

  let intent: TxIntent;
  if (body.kind === "gov_vote") {
    intent = {
      kind: "gov_vote",
      voter: address,
      proposalId: BigInt(body.proposalId),
      option: body.option,
    };
  } else if (body.kind === "gov_exec") {
    intent = { kind: "gov_exec", signer: address, proposalId: BigInt(body.proposalId) };
  } else {
    // The template's values are parsed by the REGISTRY, so a value the composer
    // could not build is a 400 here rather than a throw inside the encoder.
    const parsed = parseTemplateValues(body.templateId, body.values);
    if (!parsed.ok) {
      return Response.json(
        { error: "invalid request", detail: parsed.errors.map(describeTemplateError).join("; ") },
        { status: 400 },
      );
    }
    intent = {
      kind: "gov_submit",
      proposer: address,
      policyAddress: body.policyAddress,
      contractAddress: config.contractAddress,
      templates: [{ id: body.templateId, values: parsed.values }],
      title: body.title,
      summary: body.summary,
      metadata: body.metadata,
    };
  }

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
    return Response.json(
      { error: "simulation failed", detail: error instanceof Error ? error.message : "unknown" },
      { status: 422 },
    );
  }
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
