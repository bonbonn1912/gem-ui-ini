// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { pathBackedFiles } from "../../frontend/renderer/native-file-drop";

describe("native Tauri file drops", () => {
  it("preserves absolute paths and derives image MIME types without reading bytes", () => {
    const [image, document] = pathBackedFiles([
      "/Users/test/Bilder/Foto.JPEG",
      "C:\\workspace\\specification.pdf",
    ]);

    expect(image).toMatchObject({ name: "Foto.JPEG", type: "image/jpeg", size: 0 });
    expect((image as File & { path: string }).path).toBe("/Users/test/Bilder/Foto.JPEG");
    expect(document).toMatchObject({ name: "specification.pdf", type: "", size: 0 });
    expect((document as File & { path: string }).path).toBe(
      "C:\\workspace\\specification.pdf",
    );
  });
});
