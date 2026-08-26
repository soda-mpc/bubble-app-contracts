/**
 * HTTP client for the Python facilitator service (sodawallet/backend/facilitator-service).
 * Default base URL: http://localhost:8002
 */
export type FacilitatorJobStatus =
  | "accepted"
  | "redeeming"
  | "pending_unshield"
  | "transferring"
  | "succeeded"
  | "failed"
  | "needs_attention";

export type FacilitatorJobStep = {
  txHash: string;
  status: "pending" | "mined" | "failed";
};

export type FacilitatorSpendJob = {
  jobId: string;
  status: FacilitatorJobStatus;
  steps: {
    redeem: FacilitatorJobStep | null;
    unshield: FacilitatorJobStep | null;
    transfer: FacilitatorJobStep | null;
  };
  error: { code: string; message: string } | null;
};

export type FacilitatorEnvelope<T> = {
  success: boolean;
  message: string;
  data: T;
  meta: unknown;
  errorCode?: string;
};

export type EIP3009AuthorizationPayload = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
};

export type ExecuteAuthorizationPayload = {
  from: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
};

export type SpendRequestPayload = {
  chainId: number;
  idempotencyKey: string;
  redeem: {
    privateToken: string;
    to: string;
    data: string;
    expectedRecipient: string;
    tokenName?: string;
    authorization?: ExecuteAuthorizationPayload;
  };
  transfer: {
    token: string;
    authorization: EIP3009AuthorizationPayload;
  };
};

function facilitatorBaseUrl(): string {
  return (process.env.FACILITATOR_URL || "http://localhost:8002").replace(/\/$/, "");
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Facilitator non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
}

export async function facilitatorHealth(): Promise<FacilitatorEnvelope<{ status: string; service: string }>> {
  const res = await fetch(`${facilitatorBaseUrl()}/health`);
  const body = await readJson(res);
  if (!res.ok || !body?.success) {
    throw new Error(`Facilitator /health failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function facilitatorIsReachable(): Promise<boolean> {
  try {
    await facilitatorHealth();
    return true;
  } catch {
    return false;
  }
}

/** Probe which chainId the running service expects (from a deliberate mismatch error). */
export async function probeFacilitatorExpectedChainId(): Promise<number | null> {
  const probe = {
    chainId: 1,
    idempotencyKey: `probe-${Date.now()}`,
    redeem: {
      privateToken: "0x1111111111111111111111111111111111111111",
      to: "0x1111111111111111111111111111111111111111",
      data: "0xdeadbeef",
      expectedRecipient: "0x2222222222222222222222222222222222222222",
    },
    transfer: {
      token: "0x3333333333333333333333333333333333333333",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x4444444444444444444444444444444444444444",
        value: "1",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "11".repeat(32),
        v: 27,
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
      },
    },
  };
  const res = await fetch(`${facilitatorBaseUrl()}/v1/spend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(probe),
  });
  const body = await readJson(res);
  const message: string = body?.message || "";
  const match = message.match(/expected\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function facilitatorFaucet(params: {
  chainId: number;
  address: string;
}): Promise<FacilitatorEnvelope<{ skipped: boolean; txHash: string | null; address: string; chainId: number }>> {
  const res = await fetch(`${facilitatorBaseUrl()}/v1/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await readJson(res);
  if (!res.ok || !body?.success) {
    throw new Error(`Facilitator /v1/faucet failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function facilitatorCreateSpend(
  payload: SpendRequestPayload
): Promise<{ status: number; body: FacilitatorEnvelope<{ jobId: string; status: FacilitatorJobStatus }> | FacilitatorEnvelope<never> }> {
  const res = await fetch(`${facilitatorBaseUrl()}/v1/spend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await readJson(res);
  return { status: res.status, body };
}

export async function facilitatorGetSpend(jobId: string): Promise<FacilitatorSpendJob> {
  const res = await fetch(`${facilitatorBaseUrl()}/v1/spend/${jobId}`);
  const body = await readJson(res);
  if (!res.ok || !body?.success) {
    throw new Error(`Facilitator GET /v1/spend/${jobId} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.data as FacilitatorSpendJob;
}

export async function facilitatorCompleteTransfer(
  jobId: string,
  authorization: EIP3009AuthorizationPayload
): Promise<FacilitatorSpendJob> {
  const res = await fetch(`${facilitatorBaseUrl()}/v1/spend/${jobId}/complete-transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization }),
  });
  const body = await readJson(res);
  if (!res.ok || !body?.success) {
    throw new Error(
      `Facilitator complete-transfer failed (${res.status}): ${JSON.stringify(body)}`
    );
  }
  return body.data as FacilitatorSpendJob;
}

export async function waitForFacilitatorJob(
  jobId: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<FacilitatorSpendJob> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let last: FacilitatorSpendJob | undefined;

  while (Date.now() < deadline) {
    last = await facilitatorGetSpend(jobId);
    if (last.status === "succeeded" || last.status === "failed" || last.status === "needs_attention") {
      return last;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for facilitator job ${jobId}; last=${JSON.stringify(last)}`
  );
}
