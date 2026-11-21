// Synthetic coordinates and features in the RDP wire shape. The release digest exercises the publication pin.
export const version = "838c7ed826b26ee16a11ba2b5be9dc4d286bca8cc0159c6f33d540bf04c0155c";
export const release = { releaseId: "orn-v2-gb", version, token: version.slice(0, 16) };
export const samplePath = `/v1/river/releases/${release.token}/basins/42/samples/123`;
export const snapped = [-1.25, 52.5];
export const reach = [snapped, [-1.2, 52.4]];
export const attribution = "Synthetic network attribution";

export function locateFixture(status = "Matched", hasSample = status === "Matched") {
  return {
    data: {
      match: { status, reachId: "private-reach", candidates: [{ reachId: "private-candidate" }] },
      release: { ...release },
      basinId: hasSample ? "42" : null,
      sample: hasSample ? { sampleId: "123", position: snapped, snapOffsetM: 17 } : null,
      links: hasSample
        ? { upstream: `${samplePath}/upstream`, downstream: `${samplePath}/downstream` }
        : null,
    },
  };
}

function feature(type: string, coordinates: unknown, kind: string) {
  return {
    type: "Feature",
    geometry: { type, coordinates },
    properties: { kind, internal: "private-property" },
  };
}

export function routeFixture(direction = "upstream", geometry = "reaches") {
  return {
    type: "FeatureCollection",
    features: [
      feature("Point", snapped, "query-point"),
      ...(direction === "upstream"
        ? [feature("Polygon", [[snapped, [-1, 52.5], [-1, 52], snapped]], "catchment")]
        : []),
      ...(geometry === "reaches" ? [feature("LineString", reach, `${direction}-reach`)] : []),
    ],
    riverTracer: {
      schema: "rdp.river-tracer.route/v1",
      kind: `point-${direction}`,
      match: { status: "Matched" },
      releaseVersion: version,
      canonicalSample: { sampleId: "123", reachId: "private-reach" },
      route: { status: "traced", direction, completeness: "incomplete", reachCount: 1 },
      attribution,
      geometry: geometry === "reaches" ? "reaches" : "omitted",
    },
  };
}

export const unavailable = { error: { code: "FORBIDDEN", message: "private upstream diagnostic" } };
