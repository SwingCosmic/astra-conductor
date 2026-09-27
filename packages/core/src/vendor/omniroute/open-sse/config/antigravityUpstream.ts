export const ANTIGRAVITY_RUNTIME_BASE_URLS = Object.freeze([
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
]);

export const ANTIGRAVITY_DISCOVERY_BASE_URLS = Object.freeze([
  ...ANTIGRAVITY_RUNTIME_BASE_URLS,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
]);

export const ANTIGRAVITY_BOOTSTRAP_BASE_URLS = Object.freeze([
  "https://cloudcode-pa.googleapis.com",
]);

export function getAntigravityFetchAvailableModelsUrls(): string[] {
  return ANTIGRAVITY_DISCOVERY_BASE_URLS.map(
    (baseUrl) => `${baseUrl}/v1internal:fetchAvailableModels`,
  );
}
