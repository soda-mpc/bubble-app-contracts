import { NextRequest, NextResponse } from "next/server";
import { BUBBLE_PROXY_URL } from "~~/config/contracts";

function resolveProxyBase(): string {
  return (process.env.BUBBLE_PROXY_URL || process.env.NEXT_PUBLIC_BUBBLE_PROXY_URL || BUBBLE_PROXY_URL).replace(
    /\/+$/,
    ""
  );
}

const RETRY_MAX_ATTEMPTS = 7;
const RETRY_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(errorText: string) {
  const n = errorText.toLowerCase();
  return (
    n.includes("pending") ||
    n.includes("unknown handle") ||
    n.includes("temporarily unavailable")
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.chain_id) {
      return NextResponse.json({ error: "Chain ID is required" }, { status: 400 });
    }

    const proxyUrl = resolveProxyBase();
    const handles = body.handles;

    const forward = async (payload: Record<string, unknown>) => {
      for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
        const response = await fetch(`${proxyUrl}/encrypt-to-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          return { ok: true as const, data: await response.json() };
        }
        const errorText = await response.text();
        if (isRetryable(errorText) && attempt < RETRY_MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return { ok: false as const, status: response.status, errorText };
      }
      return { ok: false as const, status: 500, errorText: "Retry limit exceeded" };
    };

    const primary = await forward(body);
    if (primary.ok) {
      return NextResponse.json(primary.data);
    }

    // Compatibility: upstream may require single `handle`
    if (Array.isArray(handles) && handles.length > 0 && primary.errorText.toLowerCase().includes("handle is required")) {
      const outputs: string[] = [];
      for (const handle of handles) {
        const single: Record<string, unknown> = { handle, chain_id: body.chain_id };
        if (body.owner != null) single.owner = body.owner;
        if (body.user_signature != null) single.user_signature = body.user_signature;
        const result = await forward(single);
        if (!result.ok) {
          return NextResponse.json(
            { error: `Encrypt to user failed: ${result.errorText}` },
            { status: result.status }
          );
        }
        outputs.push(result.data.output);
      }
      return NextResponse.json({ outputs });
    }

    return NextResponse.json(
      { error: `Encrypt to user failed: ${primary.errorText}` },
      { status: primary.status }
    );
  } catch (error) {
    console.error("[api/encrypt-to-user]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
