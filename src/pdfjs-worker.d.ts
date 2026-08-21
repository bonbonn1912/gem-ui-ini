// Der Legacy-Worker-Build von pdfjs-dist bringt keine eigene Typdeklaration mit.
// Er wird ausschließlich als Ganzes an `globalThis.pdfjsWorker` gehängt, damit
// pdf.js seinen Worker im selben Prozess betreibt.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: {
    setup(handler: unknown, port: unknown): void;
  };
}
