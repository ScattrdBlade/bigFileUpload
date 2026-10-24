/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApngBlendOp, ApngDisposeOp, parseAPNG } from "@utils/apng";
import { GIFEncoder, nearestColorIndex, quantize } from "gifenc";

import { logger } from "../types";

const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "svg"];

const videoExtensions = ["mp4", "webm", "ogg", "ogv", "avi", "wmv", "flv", "mov", "mkv", "m4v"];

const supportedExtensions = [...imageExtensions, ...videoExtensions];

const mimeToExtension: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/tiff": "tiff",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "video/x-msvideo": "avi",
    "video/x-ms-wmv": "wmv",
    "video/x-flv": "flv",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/x-m4v": "m4v"
};

export function getExtensionFromMime(mimeType: string): string | undefined {
    const baseMime = mimeType.split(";")[0].trim().toLowerCase();
    return mimeToExtension[baseMime];
}

const extensionToMime: Record<string, string> = {
    "png": "image/png",
    "apng": "image/apng",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "tiff": "image/tiff",
    "avif": "image/avif",
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/ogg",
    "ogv": "video/ogg",
    "avi": "video/x-msvideo",
    "wmv": "video/x-ms-wmv",
    "flv": "video/x-flv",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "m4v": "video/x-m4v"
};

export function getMimeFromExtension(ext?: string): string {
    return extensionToMime[ext?.toLowerCase() ?? ""] || "application/octet-stream";
}

export interface ByteSource {
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}

const blobSource = (blob: Blob): ByteSource => ({
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
});

const MAX_PNG_CHUNKS = 100;

async function isAnimatedPng({ size, read }: ByteSource): Promise<boolean> {
    try {
        for (let offset = 8, i = 0; i < MAX_PNG_CHUNKS && offset + 8 <= size; i++) {
            const header = await read(offset, 8);
            if (header.length < 8) return false;
            const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
            if (type === "acTL") return true;
            if (type === "IDAT" || type === "IEND") return false;
            offset += 12 + header[0] * 2 ** 24 + (header[1] << 16) + (header[2] << 8) + header[3];
        }
    } catch {
    }
    return false;
}

export async function getExtensionFromBytes(blob: Blob, source: ByteSource = blobSource(blob)): Promise<string | undefined> {
    const buffer = await blob.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return "gif";
    }

    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return await isAnimatedPng(source) ? "apng" : "png";
    }

    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "webp";
    }

    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return "jpg";
    }

    return undefined;
}

const OGG_VIDEO_MARKERS = ["\x80theora", "OVP80", "BBCD\x00"];

export async function isOggVideo(blob: Blob): Promise<boolean> {
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    const text = String.fromCharCode(...head);
    return text.startsWith("OggS") && OGG_VIDEO_MARKERS.some(marker => text.includes(marker));
}

export function getUrlExtension(url: string): string | undefined {
    if (!url.startsWith("https:") && !url.startsWith("http:")) {
        url = "https:" + url;
    }
    try {
        let { pathname } = new URL(url);
        pathname = pathname.replace(/\/+$/, "");
        const lastSegment = pathname.split("/").pop() || "";
        if (!lastSegment.includes(".")) return undefined;
        const ext = lastSegment.split(".").pop()?.toLowerCase();
        if (!ext || ext.length === 0 || ext.length > 10) return undefined;
        return ext;
    } catch {
        return undefined;
    }
}

function isSupported(url: string): boolean {
    const ext = getUrlExtension(url);
    return ext ? supportedExtensions.includes(ext) : false;
}

const CDN_HOST = "cdn.discordapp.com";

const MEDIA_PROXY_HOST = "media.discordapp.net";

const IMAGES_EXT_HOST = /^images-ext-\d+\.discordapp\.net$/;

function parseUrl(url: string): URL | null {
    return URL.canParse(url) ? new URL(url) : null;
}

function isDiscordMediaUrl(url: string): boolean {
    const host = parseUrl(url)?.host ?? "";
    return host === CDN_HOST || host === MEDIA_PROXY_HOST || IMAGES_EXT_HOST.test(host);
}

export function toOriginalMediaUrl(url: string): string {
    const parsed = parseUrl(url);
    if (!parsed) return url;

    const { host, pathname, searchParams } = parsed;
    if (host === MEDIA_PROXY_HOST && /^\/(?:ephemeral-)?attachments\//.test(pathname)) {
        parsed.host = CDN_HOST;
        for (const key of ["width", "height", "size", "quality", "format"]) searchParams.delete(key);
    } else if (IMAGES_EXT_HOST.test(host) || (host === MEDIA_PROXY_HOST && pathname.startsWith("/external/"))) {
        for (const key of ["width", "height", "format", "quality", "animated"]) searchParams.delete(key);
    } else {
        return url;
    }

    return parsed.toString();
}

type MediaProps = { src?: string; href?: string; itemSrc?: string; itemHref?: string; target?: any; };

export interface MediaUrls {
    url: string;
    discordProxyUrl?: string;
}

export function getMediaUrls(props: MediaProps): MediaUrls | null {
    let candidates = [props.href, props.itemHref, props.src, props.itemSrc]
        .filter((url): url is string => typeof url === "string" && url !== "" && isSupported(url));

    if (!candidates.length && props.target?.closest) {
        const img = props.target.closest("img") || props.target.querySelector?.("img");
        const video = props.target.closest("video") || props.target.querySelector?.("video");
        const src = img?.src || video?.src;
        if (src && isSupported(src)) candidates = [src];
    }

    if (!candidates.length) return null;

    const url = toOriginalMediaUrl(candidates[0]);
    if (isDiscordMediaUrl(url)) return { url };

    const proxied = candidates.find(isDiscordMediaUrl);
    return proxied ? { url, discordProxyUrl: toOriginalMediaUrl(proxied) } : { url };
}

export const GIF_TRANSPARENT_INDEX = 0;

const ALPHA_THRESHOLD = 128;

const PALETTE_SAMPLE_PIXELS = 65536;

const PIXELS_PER_TURN = 262144;

const MAX_FRAME_PIXELS = 4096 * 4096;

const MAX_TOTAL_PIXELS = 2 ** 28;

function nextTurn(): Promise<void> {
    return new Promise(resolve => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => {
            port1.close();
            resolve();
        };
        port2.postMessage(null);
    });
}

export function gifRepeat(numPlays: number): number {
    if (!Number.isSafeInteger(numPlays) || numPlays <= 0) return 0;
    return numPlays === 1 ? -1 : Math.min(numPlays - 1, 0xFFFF);
}

export async function framePalette(data: Uint8ClampedArray | Uint8Array): Promise<{ palette: number[][]; index: Uint8Array; }> {
    const pixels = data.length >> 2;
    let opaque = 0;
    for (let p = 0; p < pixels; p++) if (data[p * 4 + 3] >= ALPHA_THRESHOLD) opaque++;

    const stride = Math.max(1, Math.ceil(opaque / PALETTE_SAMPLE_PIXELS));
    const sample = new Uint8Array(Math.ceil(opaque / stride) * 4);
    let sampled = 0;
    for (let p = 0, seen = 0; p < pixels && sampled < sample.length; p++) {
        const o = p * 4;
        if (data[o + 3] < ALPHA_THRESHOLD || seen++ % stride) continue;
        sample[sampled] = data[o];
        sample[sampled + 1] = data[o + 1];
        sample[sampled + 2] = data[o + 2];
        sample[sampled + 3] = 255;
        sampled += 4;
    }

    const colours = sampled ? quantize(sample.slice(0, sampled), 255) : [[0, 0, 0]];
    const index = new Uint8Array(pixels);
    const cache = new Uint16Array(65536).fill(0xFFFF);
    for (let start = 0; start < pixels; start += PIXELS_PER_TURN) {
        if (start) await nextTurn();
        const end = Math.min(pixels, start + PIXELS_PER_TURN);
        for (let p = start; p < end; p++) {
            const o = p * 4;
            if (data[o + 3] < ALPHA_THRESHOLD) {
                index[p] = GIF_TRANSPARENT_INDEX;
                continue;
            }
            const r = data[o], g = data[o + 1], b = data[o + 2];
            const key = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
            if (cache[key] === 0xFFFF) cache[key] = nearestColorIndex(colours, [r, g, b]);
            index[p] = cache[key] + 1;
        }
    }

    return { palette: [[0, 0, 0], ...colours], index };
}

export async function convertApngToGif(blob: Blob): Promise<Blob | null> {
    let frames: Awaited<ReturnType<typeof parseAPNG>>["frames"] = [];
    const canvas = document.createElement("canvas");
    try {
        const animation = await parseAPNG(await blob.arrayBuffer());
        ({ frames } = animation);
        const { width, height } = animation;
        if (!frames.length) return null;
        if (width * height > MAX_FRAME_PIXELS || frames.length * width * height > MAX_TOTAL_PIXELS) {
            logger.warn(`APNG not converted: ${frames.length} frames of ${width}x${height} is too much to convert`);
            return null;
        }

        const repeat = gifRepeat(animation.numPlays);
        const gif = GIFEncoder();
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;

        for (const frame of frames) {
            await nextTurn();
            const { left, top, width: frameWidth, height: frameHeight, img, delay, blendOp, disposeOp } = frame;

            const previousFrameData = disposeOp === ApngDisposeOp.PREVIOUS ? ctx.getImageData(left, top, frameWidth, frameHeight) : null;

            if (blendOp === ApngBlendOp.SOURCE) {
                ctx.clearRect(left, top, frameWidth, frameHeight);
            }

            ctx.drawImage(img, left, top, frameWidth, frameHeight);

            const { data } = ctx.getImageData(0, 0, width, height);
            const { palette, index } = await framePalette(data);

            gif.writeFrame(index, width, height, {
                transparent: true,
                transparentIndex: GIF_TRANSPARENT_INDEX,
                palette,
                delay,
                repeat
            });

            if (disposeOp === ApngDisposeOp.BACKGROUND) {
                ctx.clearRect(left, top, frameWidth, frameHeight);
            } else if (previousFrameData) {
                ctx.putImageData(previousFrameData, left, top);
            }
        }

        gif.finish();
        return new Blob([gif.bytesView() as unknown as BlobPart], { type: "image/gif" });
    } catch (e) {
        logger.error("APNG to GIF conversion error:", e);
        return null;
    } finally {
        for (const frame of frames) frame.img.src = "";
        canvas.width = canvas.height = 0;
    }
}
