// §5.4 static trust content: build-reviewed data that changes by pull
// request, which is the right auditability for trust claims. Typed module
// rather than MDX for now (plan 4.2 open question 2, §5.4 revision note):
// there is no audit report yet, so MDX tooling would be infrastructure for
// zero documents. When the first real report lands, this module grows into
// the MDX content plane; the shape below is the contract either way.

export interface AuditEntry {
  firm: string;
  /** What the engagement covered, in plain words. */
  scope: string;
  /** ISO-8601 date of the report. */
  date: string;
  reportUrl: string;
  /** The reviewed build (commit / code hash) the report covers. */
  coveredBuild: string;
}

export interface TrustContent {
  /** Empty until the first third-party audit publishes (SECURITY.md: the
   * audit is mandatory before mainnet; the UI renders the pre-audit posture
   * honestly rather than omitting the section). */
  audits: AuditEntry[];
}

export const TRUST_CONTENT: TrustContent = {
  audits: [],
};
