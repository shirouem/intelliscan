import { NextResponse } from "next/server";

export async function DELETE(
    request: Request,
    { params }: { params: { jobId: string } }
) {
    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";
    const jobId = params.jobId;

    try {
        const res = await fetch(`${browserServiceUrl}/image-solve/${jobId}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) {
            return NextResponse.json(
                { error: `Browser service returned status: ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        console.error(`[image-solve delete proxy] Error deleting ${jobId}:`, err.message);
        return NextResponse.json({ error: "Failed to delete from browser service" }, { status: 500 });
    }
}
