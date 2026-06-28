import { NextRequest, NextResponse } from "next/server";

export async function DELETE(req: NextRequest) {
    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";
    try {
        const res = await fetch(`${browserServiceUrl}/image-solve/all`, {
            method: "DELETE",
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => null);
            return NextResponse.json({ error: errorData?.error || `HTTP error! status: ${res.status}` }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: unknown) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
