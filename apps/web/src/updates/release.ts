export const RELEASE_REPOSITORY = "sportwhiz/open-whiteboard";
// GitHub keeps this identity when the official repository is renamed. Pin the
// release channel to it so an old name's redirect is never needed for discovery.
export const RELEASE_REPOSITORY_ID = 1404455583;
export const UPDATER_PROTOCOL = 1;
export type Release = {
  version: string;
  commit: string;
  schema: string;
  dataFormat: number;
  protocol: number;
  security: boolean;
  important?: boolean;
  notes: string;
};
export function parseRelease(value: unknown): Release {
  if (!value || typeof value !== "object")
    throw new Error("Invalid release metadata.");
  const r = value as Release;
  if (
    !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(r.version) ||
    !/^[a-f0-9]{40}$/.test(r.commit) ||
    !/^[a-f0-9]{64}$/.test(r.schema) ||
    !Number.isSafeInteger(r.protocol) ||
    r.protocol < 1 ||
    !Number.isSafeInteger(r.dataFormat) ||
    r.dataFormat < 1 ||
    typeof r.security !== "boolean" ||
    (r.important !== undefined && typeof r.important !== "boolean") ||
    typeof r.notes !== "string" ||
    r.notes.length > 12000
  )
    throw new Error("Invalid release metadata.");
  return {
    version: r.version,
    commit: r.commit,
    schema: r.schema,
    dataFormat: r.dataFormat,
    protocol: r.protocol,
    security: r.security,
    ...(r.important === undefined ? {} : { important: r.important }),
    notes: r.notes,
  };
}
export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function compatibleRelease(
  release: Release,
  current: Release,
  rollback = false,
) {
  if (release.protocol > UPDATER_PROTOCOL)
    return "This release needs a newer deployment runner. Update the installer repository first.";
  if (release.dataFormat !== current.dataFormat)
    return "This release needs a guided data upgrade.";
  if (rollback && release.schema !== current.schema)
    return "This version uses a different database schema. Use the documented recovery procedure.";
  return null;
}
