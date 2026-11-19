import "server-only";
import { RdpError } from "./errors";

export type RdpStage = "staging" | "production";

export type FixtureConfig = { mode: "fixture" };
export type LiveConfig = {
  mode: "live";
  stage: RdpStage;
  apiUrl: string;
  roleArn: string;
  region: "eu-west-1";
};
export type RdpConfig = FixtureConfig | LiveConfig;

type Env = Readonly<Record<string, string | undefined>>;

/** Vercel environment → RDP stage. Development tokens are rejected by the role trust, so live mode needs a deployment. */
const STAGES: Readonly<Record<string, RdpStage>> = { preview: "staging", production: "production" };

/**
 * `RDP_DATA_MODE` selects `fixture` (bundled sample responses, never real observations) or `live` (signed reads of
 * RDP). It defaults to `fixture` only outside Vercel. Vercel Production must be explicitly `live`: sample data is
 * never served there.
 */
export function readRdpConfig(env: Env = process.env): RdpConfig {
  const vercel = env.VERCEL_ENV;
  const mode = env.RDP_DATA_MODE ?? (vercel ? undefined : "fixture");
  if (mode === "fixture") {
    if (vercel === "production") throw new RdpError("CONFIGURATION_ERROR");
    return { mode: "fixture" };
  }
  if (mode !== "live") throw new RdpError("CONFIGURATION_ERROR");

  const stage = vercel ? STAGES[vercel] : undefined;
  if (!stage || env.RDP_AWS_REGION !== "eu-west-1") throw new RdpError("CONFIGURATION_ERROR");
  const environment = vercel as "preview" | "production";

  // Only RDP-UI's own dedicated stage role, never isHPPOpen's `-vercel-<environment>` or another stage's.
  const roleArn = env.RDP_ROLE_ARN ?? "";
  const role = new RegExp(
    `^arn:aws:iam::[0-9]{12}:role/river-data-platform-${stage}-ui-vercel-${environment}$`,
  );
  // Exact execute-api origin plus the stage path: no userinfo, port, query, fragment or other host.
  const apiUrl = env.RDP_READ_API_URL ?? "";
  const api = new RegExp(
    `^https://[a-z0-9]{1,32}\\.execute-api\\.eu-west-1\\.amazonaws\\.com/${stage}$`,
  );
  if (!role.test(roleArn) || !api.test(apiUrl)) throw new RdpError("CONFIGURATION_ERROR");

  return Object.freeze({ mode: "live", stage, apiUrl, roleArn, region: "eu-west-1" });
}
