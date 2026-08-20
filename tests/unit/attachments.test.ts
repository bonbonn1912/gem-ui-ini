import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttachmentService,
  AttachmentValidationError,
  detectImageMime,
  InMemoryAttachmentPersistence,
} from "../../src/main/attachments/attachment-service";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

describe("AttachmentService", () => {
  it("erkennt unterstützte Magic Bytes", () => {
    expect(detectImageMime(PNG)).toBe("image/png");
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(detectImageMime(new TextEncoder().encode("kein Bild"))).toBeNull();
  });

  it("staged geprüfte Bilder mit zufälligem Dateinamen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-attachment-"));
    const service = new AttachmentService(
      directory,
      new InMemoryAttachmentPersistence(),
    );

    const attachment = await service.stageBytes({
      bytes: PNG,
      displayName: "Screenshot.png",
      declaredMimeType: "image/png",
    });

    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.displayName).toBe("Screenshot.png");
    expect(await service.getPreviewBytes(attachment.id)).toEqual(PNG);
    const promptImage = await service.getPromptImages([attachment.id]);
    expect(Buffer.from(promptImage[0].data, "base64")).toEqual(Buffer.from(PNG));
  });

  it("weist MIME-Spoofing zurück", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-attachment-"));
    const service = new AttachmentService(
      directory,
      new InMemoryAttachmentPersistence(),
    );

    await expect(
      service.stageBytes({
        bytes: PNG,
        declaredMimeType: "image/jpeg",
      }),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });
});
