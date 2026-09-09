import { NextRequest, NextResponse } from "next/server";
import { BUBBLE_PROXY_URL } from "~~/config/contracts";

function resolveProxyBase(): string {
  return (process.env.BUBBLE_PROXY_URL || process.env.NEXT_PUBLIC_BUBBLE_PROXY_URL || BUBBLE_PROXY_URL).replace(
    /\/+$/,
    ""
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const proxyUrl = resolveProxyBase();
    const response = await fetch(`${proxyUrl}/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      return NextResponse.json({ error: `Onboarding failed: ${text}` }, { status: response.status });
    }

    return NextResponse.json(JSON.parse(text));
  } catch (error) {
    console.error("[api/onboard]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
