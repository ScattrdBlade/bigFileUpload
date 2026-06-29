/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApngBlendOp, ApngDisposeOp, parseAPNG } from "@utils/apng";
import { applyPalette, GIFEncoder, quantize } from "gifenc";

export async function convertApngToGif(blob: Blob): Promise<Blob | null> {
    try {
        const buffer = await blob.arrayBuffer();
        const { frames, width, height } = await parseAPNG(buffer);

        if (!frames.length) return null;

        const gif = GIFEncoder();

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;

        for (const frame of frames) {
            const { left, top, width: frameWidth, height: frameHeight, img, delay, blendOp, disposeOp } = frame;

            const previousFrameData = ctx.getImageData(left, top, frameWidth, frameHeight);

            if (blendOp === ApngBlendOp.SOURCE) {
                ctx.clearRect(left, top, frameWidth, frameHeight);
            }

            ctx.drawImage(img, left, top, frameWidth, frameHeight);

            const { data } = ctx.getImageData(0, 0, width, height);
            const palette = quantize(data, 256);
            const index = applyPalette(data, palette);

            gif.writeFrame(index, width, height, {
                transparent: true,
                palette,
                delay
            });

            if (disposeOp === ApngDisposeOp.BACKGROUND) {
                ctx.clearRect(left, top, frameWidth, frameHeight);
            } else if (disposeOp === ApngDisposeOp.PREVIOUS) {
                ctx.putImageData(previousFrameData, left, top);
            }
        }

        gif.finish();
        return new Blob([gif.bytesView() as unknown as BlobPart], { type: "image/gif" });
    } catch (e) {
        console.error("[BigFileUpload] APNG to GIF conversion error:", e);
        return null;
    }
}
