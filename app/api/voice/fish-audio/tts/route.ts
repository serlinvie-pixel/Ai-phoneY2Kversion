import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_BASE_URL = "https://api.fish.audio/v1";
const MAX_TEXT_LENGTH = 5000;

/**
 * Server-side Fish Audio TTS proxy.
 * The browser sends the user's key only to this same-origin route, avoiding
 * Fish Audio browser CORS restrictions. Credentials are never logged or stored.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim()
            ? body.baseUrl.trim().replace(/\/+$/, "")
            : DEFAULT_BASE_URL;
        const model = typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "s2.1-pro-free";
        const referenceId = typeof body.referenceId === "string" ? body.referenceId.trim() : "";
        const speedValue = Number(body.speed);
        const speed = Number.isFinite(speedValue) ? Math.min(2, Math.max(0.5, speedValue)) : 1;

        if (!apiKey) return NextResponse.json({ error: "Fish Audio API Key 未配置" }, { status: 400 });
        if (!text) return NextResponse.json({ error: "合成文本不能为空" }, { status: 400 });
        if (text.length > MAX_TEXT_LENGTH) {
            return NextResponse.json({ error: `文本过长（最多 ${MAX_TEXT_LENGTH} 个字符）` }, { status: 413 });
        }

        let target: URL;
        try {
            target = new URL(`${baseUrl}/tts`);
        } catch {
            return NextResponse.json({ error: "Fish Audio Base URL 格式不正确" }, { status: 400 });
        }
        // Do not turn this endpoint into an arbitrary URL proxy.
        if (target.protocol !== "https:" || target.hostname !== "api.fish.audio" || target.port) {
            return NextResponse.json({ error: "目前仅支持官方地址 https://api.fish.audio/v1" }, { status: 400 });
        }
        if (!target.pathname.endsWith("/v1/tts")) {
            return NextResponse.json({ error: "Fish Audio Base URL 应为 https://api.fish.audio/v1" }, { status: 400 });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 115_000);
        let upstream: Response;
        try {
            upstream = await fetch(target.toString(), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    model,
                },
                body: JSON.stringify({
                    text,
                    ...(referenceId ? { reference_id: referenceId } : {}),
                    format: "mp3",
                    prosody: { speed },
                }),
                signal: controller.signal,
                cache: "no-store",
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!upstream.ok) {
            const detail = await upstream.text().catch(() => "");
            return NextResponse.json({
                error: "Fish Audio TTS 请求失败",
                status: upstream.status,
                detail: detail.slice(0, 1000),
            }, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
        }

        const audio = await upstream.arrayBuffer();
        if (!audio.byteLength) {
            return NextResponse.json({ error: "Fish Audio 未返回音频数据" }, { status: 502 });
        }

        return new Response(audio, {
            status: 200,
            headers: {
                "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
            ? "Fish Audio 请求超时"
            : error instanceof Error ? error.message : "未知服务端错误";
        return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 });
    }
}
