// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRdpConfig } from "@/lib/rdp/config";

const STAGING = {
  VERCEL_ENV: "preview",
  RDP_DATA_MODE: "live",
  RDP_AWS_REGION: "eu-west-1",
  RDP_READ_API_URL: "https://abc123.execute-api.eu-west-1.amazonaws.com/staging",
  RDP_ROLE_ARN: "arn:aws:iam::123456789012:role/river-data-platform-staging-ui-vercel-preview",
};
const PRODUCTION = {
  ...STAGING,
  VERCEL_ENV: "production",
  RDP_READ_API_URL: "https://prod99.execute-api.eu-west-1.amazonaws.com/production",
  RDP_ROLE_ARN:
    "arn:aws:iam::123456789012:role/river-data-platform-production-ui-vercel-production",
};

function rejects(env: Record<string, string | undefined>) {
  expect(() => readRdpConfig(env)).toThrow(
    expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
  );
}

describe("RDP configuration", () => {
  it("defaults to fixture mode only outside Vercel", () => {
    expect(readRdpConfig({})).toEqual({ mode: "fixture" });
    expect(readRdpConfig({ VERCEL_ENV: "preview", RDP_DATA_MODE: "fixture" })).toEqual({
      mode: "fixture",
    });
    rejects({ VERCEL_ENV: "preview" });
  });

  it("never serves fixture data on Vercel Production", () => {
    rejects({ VERCEL_ENV: "production", RDP_DATA_MODE: "fixture" });
    rejects({ VERCEL_ENV: "production" });
  });

  it("binds live mode to the matching stage and RDP-UI's dedicated role", () => {
    expect(readRdpConfig(STAGING)).toMatchObject({ mode: "live", stage: "staging" });
    expect(readRdpConfig(PRODUCTION)).toMatchObject({ mode: "live", stage: "production" });
  });

  it.each([
    [
      "isHPPOpen's caller role",
      { RDP_ROLE_ARN: "arn:aws:iam::123456789012:role/river-data-platform-staging-vercel-preview" },
    ],
    ["the other stage's UI role", { RDP_ROLE_ARN: PRODUCTION.RDP_ROLE_ARN }],
    [
      "the predictor role",
      { RDP_ROLE_ARN: "arn:aws:iam::123456789012:role/river-data-platform-production-predictor" },
    ],
    ["the other stage's API", { RDP_READ_API_URL: PRODUCTION.RDP_READ_API_URL }],
    ["a non-AWS host", { RDP_READ_API_URL: "https://example.com/staging" }],
    [
      "userinfo in the URL",
      { RDP_READ_API_URL: "https://x@abc123.execute-api.eu-west-1.amazonaws.com/staging" },
    ],
    ["a trailing path", { RDP_READ_API_URL: `${STAGING.RDP_READ_API_URL}/v1` }],
    ["another region", { RDP_AWS_REGION: "eu-west-2" }],
    ["local development", { VERCEL_ENV: "development" }],
    ["no Vercel environment", { VERCEL_ENV: undefined }],
    ["an unknown mode", { RDP_DATA_MODE: "proxy" }],
  ])("rejects %s", (_name, override) => {
    rejects({ ...STAGING, ...override });
  });
});
