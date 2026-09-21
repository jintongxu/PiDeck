import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PICGO_SERVER_URL = "http://127.0.0.1:36677/upload";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

type DecodedImage = {
	bytes: Buffer;
	extension: string;
};

/** Decode only clipboard-friendly raster image data URLs accepted by PicGo. */
export function decodePicGoImageDataUrl(dataUrl: string): DecodedImage {
	if (typeof dataUrl !== "string") throw new Error("PICGO_IMAGE_INVALID");
	const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
	if (!match) throw new Error("PICGO_IMAGE_INVALID");
	const [, mimeType, encoded] = match;
	const bytes = Buffer.from(encoded.replace(/[\r\n]/g, ""), "base64");
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("PICGO_IMAGE_TOO_LARGE");
	return { bytes, extension: MIME_EXTENSIONS[mimeType] };
}

export function extractPicGoUrl(payload: unknown): string {
	if (!payload || typeof payload !== "object") throw new Error("PICGO_RESPONSE_INVALID");
	const typed = payload as { success?: unknown; result?: unknown };
	if (typed.success !== true) throw new Error("PICGO_RESPONSE_INVALID");
	const result = typed.result;
	const candidate = Array.isArray(result) ? result[0] : result;
	if (typeof candidate !== "string" || !candidate.trim()) throw new Error("PICGO_RESPONSE_INVALID");
	let parsed: URL;
	try {
		parsed = new URL(candidate.trim());
	} catch {
		throw new Error("PICGO_RESPONSE_INVALID");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("PICGO_RESPONSE_INVALID");
	}
	return parsed.toString();
}

/** Upload one clipboard image through PicGo's local Server and return its public URL. */
export async function uploadImageToPicGo(dataUrl: string): Promise<string> {
	const decoded = decodePicGoImageDataUrl(dataUrl);
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-picgo-"));
	const tempPath = join(tempDir, `clipboard${decoded.extension}`);
	try {
		await writeFile(tempPath, decoded.bytes, { flag: "wx" });
		const response = await fetch(PICGO_SERVER_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ list: [tempPath] }),
			signal: AbortSignal.timeout(30_000),
		});
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > MAX_RESPONSE_BYTES) throw new Error("PICGO_RESPONSE_INVALID");
		if (!response.ok) throw new Error("PICGO_UNAVAILABLE");
		const responseText = await response.text();
		if (responseText.length > MAX_RESPONSE_BYTES) throw new Error("PICGO_RESPONSE_INVALID");
		return extractPicGoUrl(JSON.parse(responseText) as unknown);
	} catch (error) {
		if (error instanceof Error && /^PICGO_/.test(error.message)) throw error;
		throw new Error("PICGO_UNAVAILABLE");
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
