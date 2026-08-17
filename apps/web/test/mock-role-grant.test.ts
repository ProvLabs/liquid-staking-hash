// Grant-knob gates: unset, the touched handlers answer byte-identical to
// the captured fixtures; set, each response is the fixture plus exactly one
// appended/re-pointed entry.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import contractConfig from "@nvhash/fixtures/queries/contract/config";
import contractValidators from "@nvhash/fixtures/queries/contract/validators";
import groupMembers from "@nvhash/fixtures/queries/group/group-members";
import groupPoliciesByGroup from "@nvhash/fixtures/queries/group/group-policies-by-group";

import { FIXTURE_CONTRACT_ADDRESS } from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  delete process.env.NVHASH_MOCK_GRANT_ROLES;
  server.resetHandlers();
});
afterAll(() => server.close());

const GRANTED = "tp1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz".slice(0, 41);
const ADMIN = (contractConfig as { data: { admin: string } }).data.admin;
const GROUP_ID = "1";
const FIRST_POLICY = (groupPoliciesByGroup as { group_policies: Array<{ address: string }> })
  .group_policies[0];

const validatorsQuery = Buffer.from(JSON.stringify({ validators: {} })).toString("base64");
const validatorsUrl = `http://lcd.mock/cosmwasm/wasm/v1/contract/${FIXTURE_CONTRACT_ADDRESS}/smart/${encodeURIComponent(validatorsQuery)}`;

describe("NVHASH_MOCK_GRANT_ROLES inertness (knob unset)", () => {
  it("group_policy_info on the admin still 404s (the corpus's plain-account truth)", async () => {
    const res = await fetch(`http://lcd.mock/cosmos/group/v1/group_policy_info/${ADMIN}`);
    expect(res.status).toBe(404);
  });

  it("group_members answers the fixture byte-identically", async () => {
    const res = await fetch(`http://lcd.mock/cosmos/group/v1/group_members/${GROUP_ID}`);
    expect(await res.json()).toEqual(groupMembers);
  });

  it("the validators smart query answers the fixture byte-identically", async () => {
    const res = await fetch(validatorsUrl);
    expect(await res.json()).toEqual(contractValidators);
  });
});

describe("NVHASH_MOCK_GRANT_ROLES derivation (knob set)", () => {
  it("rejects a malformed knob value rather than clamping", async () => {
    // The handler throws on a malformed value (bounded at the boundary); MSW
    // surfaces a thrown handler as a 500 — a loud failure, never a clamped
    // or silently ignored grant.
    process.env.NVHASH_MOCK_GRANT_ROLES = "NOT-AN-ADDRESS";
    const res = await fetch(`http://lcd.mock/cosmos/group/v1/group_members/${GROUP_ID}`);
    expect(res.status).toBe(500);
  });

  it("the admin answers as a governed policy — the captured policy re-pointed", async () => {
    process.env.NVHASH_MOCK_GRANT_ROLES = GRANTED;
    const res = await fetch(`http://lcd.mock/cosmos/group/v1/group_policy_info/${ADMIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { address: string; group_id: string } };
    expect(body.info.address).toBe(ADMIN);
    // Everything else is the captured policy's own fields, not invention.
    expect(body.info.group_id).toBe(
      (FIRST_POLICY as unknown as { group_id: string } | undefined)?.group_id,
    );
  });

  it("group_members is the fixture PLUS exactly one appended row for the grant", async () => {
    process.env.NVHASH_MOCK_GRANT_ROLES = GRANTED;
    const res = await fetch(`http://lcd.mock/cosmos/group/v1/group_members/${GROUP_ID}`);
    const body = (await res.json()) as { members: Array<{ member: { address: string } }> };
    const fixture = groupMembers as { members: Array<{ member: { address: string } }> };
    expect(body.members).toHaveLength(fixture.members.length + 1);
    expect(body.members.slice(0, fixture.members.length)).toEqual(fixture.members);
    expect(body.members[fixture.members.length]?.member.address).toBe(GRANTED);
  });

  it("the validator set is the fixture PLUS one cloned row operated by the grant", async () => {
    process.env.NVHASH_MOCK_GRANT_ROLES = GRANTED;
    const res = await fetch(validatorsUrl);
    const body = (await res.json()) as {
      data: { validators: Array<{ operator: string; valoper: string }> };
    };
    const fixture = contractValidators as {
      data: { validators: Array<{ operator: string; valoper: string }> };
    };
    expect(body.data.validators).toHaveLength(fixture.data.validators.length + 1);
    expect(body.data.validators.slice(0, fixture.data.validators.length)).toEqual(
      fixture.data.validators,
    );
    const appended = body.data.validators[fixture.data.validators.length];
    expect(appended?.operator).toBe(GRANTED);
    // The derived valoper duplicates no captured key.
    expect(fixture.data.validators.some((v) => v.valoper === appended?.valoper)).toBe(false);
  });
});
