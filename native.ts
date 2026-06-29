/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { NativeUploadResult, NestUploadResponse } from "./types";

let uploadProgress = { loaded: 0, total: 0 };

export async function getUploadProgress(_: IpcMainInvokeEvent): Promise<{ loaded: number; total: number; }> {
    return uploadProgress;
}

const UPLOAD_CHUNK_SIZE = 262144; // 256 KB

function progressStream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    uploadProgress = { loaded: 0, total };
    let index = 0;
    let offset = 0;
    let loaded = 0;
    return new ReadableStream({
        pull(controller) {
            while (index < parts.length && offset >= parts[index].length) {
                index++;
                offset = 0;
            }
            if (index >= parts.length) {
                controller.close();
                return;
            }
            const part = parts[index];
            const end = Math.min(offset + UPLOAD_CHUNK_SIZE, part.length);
            controller.enqueue(part.subarray(offset, end));
            loaded += end - offset;
            offset = end;
            uploadProgress = { loaded, total };
        }
    });
}

function streamFetch(url: string, method: string, headers: Record<string, string>, parts: Uint8Array[], contentType?: string): Promise<Response> {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const finalHeaders: Record<string, string> = { ...headers, "Content-Length": String(total) };
    if (contentType) finalHeaders["Content-Type"] = contentType;
    return fetch(url, {
        method,
        headers: finalHeaders,
        body: progressStream(parts),
        duplex: "half"
    } as RequestInit & { duplex: "half"; });
}

// multipart/form-data POST with progress tracking.
function multipartFetch(url: string, fields: Record<string, string>, fileFieldName: string, fileBuffer: ArrayBuffer, filename: string, headers: Record<string, string> = {}): Promise<Response> {
    const boundary = `----BigFileUpload${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const encoder = new TextEncoder();
    const safeName = filename.replace(/[\r\n"]/g, "_");
    let head = "";
    for (const [name, value] of Object.entries(fields)) {
        head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const parts = [encoder.encode(head), new Uint8Array(fileBuffer), encoder.encode(`\r\n--${boundary}--\r\n`)];
    return streamFetch(url, "POST", headers, parts, `multipart/form-data; boundary=${boundary}`);
}

// raw body PUT/POST with progress tracking.
function rawFetch(url: string, method: string, fileBuffer: ArrayBuffer, headers: Record<string, string> = {}): Promise<Response> {
    return streamFetch(url, method, headers, [new Uint8Array(fileBuffer)]);
}

export async function uploadToNest(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    authToken: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://nest.rip/api/files/upload", {}, "file", fileBuffer, filename, { Authorization: authToken });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const data = await response.json() as NestUploadResponse;

        if (data.fileURL) {
            return { success: true, url: data.fileURL };
        }

        return { success: false, error: "No URL returned from upload" };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToEzHost(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    key: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://api.e-z.host/files", {}, "file", fileBuffer, filename, { key });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const data = await response.json() as { success: boolean; error?: string; imageUrl?: string; rawUrl?: string; };

        if (!data || !data.success) {
            return { success: false, error: data?.error || "Upload failed" };
        }

        if (data.imageUrl || data.rawUrl) {
            return { success: true, url: data.imageUrl || data.rawUrl };
        }

        return { success: false, error: "No URL returned from upload" };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadTo0x0(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://0x0.st", {}, "file", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: text };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToS3(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>
): Promise<NativeUploadResult> {
    try {
        const response = await rawFetch(uploadUrl, "PUT", fileBuffer, headers);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        return { success: true, url: uploadUrl };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToCatbox(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    userhash?: string
): Promise<NativeUploadResult> {
    try {
        const fields: Record<string, string> = { reqtype: "fileupload" };
        if (userhash) fields.userhash = userhash;
        const response = await multipartFetch("https://catbox.moe/user/api.php", fields, "fileToUpload", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: text };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToLitterbox(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    expiry: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://litterbox.catbox.moe/resources/internals/api.php", { reqtype: "fileupload", time: expiry }, "fileToUpload", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: text };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToGofile(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    token?: string
): Promise<NativeUploadResult> {
    try {
        const fields: Record<string, string> = {};
        if (token?.trim()) fields.token = token.trim();
        const response = await multipartFetch("https://upload.gofile.io/uploadfile", fields, "file", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const data = await response.json() as {
            status?: string;
            error?: string;
            data?: { downloadPage?: string; code?: string; };
        };

        if (data.status !== "ok") {
            return { success: false, error: data.error || "Upload failed" };
        }

        const url = data.data?.downloadPage || (data.data?.code ? `https://gofile.io/d/${data.data.code}` : "");
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToTmpfiles(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://tmpfiles.org/api/v1/upload", {}, "file", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const data = await response.json() as { status?: string; data?: { url?: string; }; };
        const rawUrl = data.data?.url || "";
        if (!rawUrl || data.status !== "success") {
            return { success: false, error: "No URL returned from upload" };
        }

        const url = rawUrl.includes("tmpfiles.org/") && !rawUrl.includes("/dl/")
            ? rawUrl.replace(/tmpfiles\.org\/(\d+)/, "tmpfiles.org/dl/$1")
            : rawUrl;

        return { success: true, url };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToBuzzheavier(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        const response = await rawFetch(`https://w.buzzheavier.com/${encodeURIComponent(filename)}`, "PUT", fileBuffer);

        const text = await response.text();
        if (!response.ok) {
            return { success: false, error: `Upload failed: ${response.status} ${text}` };
        }

        try {
            const data = JSON.parse(text) as { code?: number; data?: { id?: string; }; };
            if (data.code === 201 && data.data?.id) {
                return { success: true, url: `https://buzzheavier.com/${data.data.id}` };
            }
        } catch {
        }

        const url = text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToTempSh(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://temp.sh/upload", {}, "file", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        const url = (await response.text()).trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToFilebin(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        const binId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
        const uploadUrl = `https://filebin.net/${binId}/${encodeURIComponent(filename)}`;

        const response = await multipartFetch(uploadUrl, {}, "file", fileBuffer, filename);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        return { success: true, url: `https://filebin.net/${binId}/${encodeURIComponent(filename)}` };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToPixelVault(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    uploadKey: string
): Promise<NativeUploadResult> {
    try {
        const response = await multipartFetch("https://pixelvault.co/", {}, "file", fileBuffer, filename, { Authorization: uploadKey });

        const text = await response.text();
        let data: { resource?: string; url?: string; } | null = null;

        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!response.ok) {
            return { success: false, error: `Upload failed: ${response.status} ${text}` };
        }

        const url = data?.resource || data?.url || text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function uploadToPixelDrain(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    apiKey?: string
): Promise<NativeUploadResult> {
    try {
        const headers: Record<string, string> = {};
        if (apiKey?.trim()) {
            headers.Authorization = `Basic ${Buffer.from(`:${apiKey.trim()}`).toString("base64")}`;
        }

        const response = await rawFetch(`https://pixeldrain.com/api/file/${encodeURIComponent(filename)}`, "PUT", fileBuffer, headers);

        const text = await response.text();
        let data: { id?: string; message?: string; } | null = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!response.ok) {
            return { success: false, error: data?.message || `Upload failed: ${response.status} ${text}` };
        }

        if (!data?.id) {
            return { success: false, error: data?.message || "No URL returned from upload" };
        }

        return { success: true, url: `https://pixeldrain.com/u/${data.id}` };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

function isValidHttpsUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
    } catch {
        return false;
    }
}

export async function uploadToWebdav(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>
): Promise<NativeUploadResult> {
    if (!isValidHttpsUrl(uploadUrl)) {
        return { success: false, error: "Invalid or non-HTTPS upload URL" };
    }

    try {
        const response = await rawFetch(uploadUrl, "PUT", fileBuffer, headers);

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }

        return { success: true, url: uploadUrl };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function createWebdavShare(
    _: IpcMainInvokeEvent,
    ocsUrl: string,
    headers: Record<string, string>,
    body: string
): Promise<NativeUploadResult> {
    if (!isValidHttpsUrl(ocsUrl)) {
        return { success: false, error: "Invalid or non-HTTPS share endpoint URL" };
    }

    try {
        const response = await fetch(ocsUrl, {
            method: "POST",
            headers,
            body
        });

        const text = await response.text();

        if (!response.ok) {
            return { success: false, error: `Share creation failed: ${response.status} ${text.slice(0, 200)}` };
        }

        let data: { ocs?: { data?: { token?: string; }; }; };
        try {
            data = JSON.parse(text);
        } catch {
            return { success: false, error: `Invalid share response: ${text.slice(0, 200)}` };
        }

        const token = data?.ocs?.data?.token;
        if (!token) {
            return { success: false, error: "No share token in server response" };
        }

        return { success: true, url: token };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
}

export async function fetchFile(
    _: IpcMainInvokeEvent,
    url: string,
    timeoutMs: number = 300000
): Promise<{ success: boolean; data?: ArrayBuffer; contentType?: string; error?: string; }> {
    if (!isValidHttpsUrl(url)) {
        return { success: false, error: "Refusing to fetch a non-HTTPS URL" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            return { success: false, error: `Fetch failed: ${response.status} ${response.statusText}` };
        }
        const data = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "";
        return { success: true, data, contentType };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    } finally {
        clearTimeout(timeout);
    }
}
