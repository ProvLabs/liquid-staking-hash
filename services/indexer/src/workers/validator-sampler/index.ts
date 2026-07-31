// The validator-sampler worker (app-spec §9.2) →
// `validator_registry` + `validator_epochs`. Anchored to epoch cranks and read
// height-pinned AS OF each crank (finalized per-epoch validator economics),
// structurally a sibling of epoch-history — so it backfills and replays
// deterministically. `collect` finds cranks (tx-search) and samples each
// height-pinned (no DB); `write` upserts registry/epoch rows and marks
// departures (no network).

import { STREAMS } from "../../runtime/streams.ts";
import type { Worker } from "../../runtime/worker.ts";
import type { PinnedLcdClient, RpcClient } from "../../transport/rpc.ts";
import { collectCranks } from "../epoch-history/boundaries.ts";
import { sampleCrank, type CrankSample, type SamplerSource } from "./sample.ts";
import { PrismaValidatorStore } from "./store.ts";
import { applySamples } from "./write.ts";

export interface ValidatorSamplerDeps {
  readonly rpc: RpcClient;
  readonly pinned: PinnedLcdClient;
  readonly contractAddress: string;
  readonly startHeight?: bigint;
}

export function createValidatorSamplerWorker(deps: ValidatorSamplerDeps): Worker<CrankSample[]> {
  const source: SamplerSource = {
    smartAtHeight: (contract, query, height) => deps.pinned.smartAtHeight(contract, query, height),
    getAtHeight: (path, params, height) => deps.pinned.getAtHeight(path, params, height),
    blockTime: (height) => deps.rpc.blockTime(height),
  };

  return {
    stream: STREAMS.validatorSampler,
    startHeight: deps.startHeight ?? 0n,
    collect: async (window) => {
      const cranks = await collectCranks(deps.rpc, deps.contractAddress, window);
      const samples: CrankSample[] = [];
      for (const crank of cranks) {
        const sample = await sampleCrank(source, deps.contractAddress, crank);
        if (sample) samples.push(sample);
      }
      return samples;
    },
    write: (tx, _window, samples) => applySamples(new PrismaValidatorStore(tx), samples),
  };
}
