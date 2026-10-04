export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function invariantError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    CLIENT_LIMIT: "The active client registration limit has been reached.",
    LAST_OWNER: "Transfer installation ownership before changing this account.",
    LAST_METHOD: "Keep at least one usable sign-in method.",
    METHOD_CHANGED:
      "This sign-in method changed. Refresh your account settings.",
    LAST_FACTOR:
      "Add a working passkey before removing the last required factor.",
    SEAT_LIMIT: "The installation account limit has been reached.",
    BOARD_LIMIT: "The installation board limit has been reached.",
    USER_BOARD_LIMIT: "Your board limit has been reached.",
    STORAGE_LIMIT: "The installation storage limit has been reached.",
    USER_STORAGE_LIMIT: "Your storage limit has been reached.",
    STORAGE_INVENTORY_REQUIRED:
      "Storage inventory is still being reconciled. Existing boards remain available; try the upload shortly.",
    ASSET_RETRY:
      "This asset is being reconciled. Please retry the upload shortly.",
    EMAIL_PROOF_EXPIRED:
      "This email confirmation is no longer valid. Request a new confirmation.",
    MAIL_LIMIT: "The daily email limit has been reached.",
    REPLACEMENT_FACTOR_REQUIRED:
      "Enroll and verify a replacement factor first.",
    INVALID_RECIPIENT:
      "Choose a verified active member to receive the content.",
    CONTENT_TRANSFER_CONFLICT:
      "Some selected content is no longer owned by this account. Refresh the inventory.",
    OWNERSHIP_TRANSFER_CONFLICT:
      "Ownership or collaborator access changed. Refresh sharing settings before trying again.",
    ACCOUNT_UNAVAILABLE:
      "This account cannot receive access or create content.",
  };
  for (const [code, explanation] of Object.entries(known))
    if (new RegExp(`\\b${code}\\b`, "u").test(message))
      return new HttpError(409, explanation, code);
  return null;
}
