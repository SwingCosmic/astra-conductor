import { decodeGrokResetCreditsFrame } from "./grokResetCreditsFrame.ts";

const GROK_RESET_CREDITS_URL =
  "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";

export async function fetchGrokResetCredits(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  if (!accessToken) return null;
  try {
    const response = await fetchImpl(GROK_RESET_CREDITS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
      },
      body: Buffer.from([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return decodeGrokResetCreditsFrame(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}
