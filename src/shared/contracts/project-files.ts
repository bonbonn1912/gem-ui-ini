import { z } from "zod";

import {
  DisplayNameSchema,
  EntityIdSchema,
  RootRevisionSchema,
} from "./common";

export const MAX_PROJECT_FILE_SEARCH_RESULTS = 24;
/** Wie viele Dateien ein einzelner Ordnerbezug höchstens in den Prompt bringt. */
export const MAX_PROJECT_FILES_PER_DIRECTORY = 25;
export const MAX_PROJECT_FILE_REFERENCES_PER_PROMPT = 10;
export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_PROJECT_FILE_CHARS = 60_000;
export const MAX_PROJECT_FILE_TOTAL_CHARS = 160_000;

/**
 * Die @-Auswahl kennt zwei Arten von Zielen: eine einzelne Datei und einen
 * ganzen Ordner. Der Ordner wird beim Senden zu seinen lesbaren Dateien
 * aufgelöst.
 */
export const ProjectEntryKindSchema = z.enum(["file", "directory"]);

export const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes("\0"), "Project file paths must not contain NUL bytes")
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "Project file paths must be relative")
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), "Project file paths must not contain a drive root")
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === ".."),
    "Project file paths must contain only safe path segments",
  );

export const ProjectFileReferenceInputSchema = z
  .object({
    rootId: EntityIdSchema,
    relativePath: ProjectRelativePathSchema,
    // Vorgabe "file", damit ältere gespeicherte Bezüge unverändert gelten.
    kind: ProjectEntryKindSchema.default("file"),
  })
  .strict();

export const ProjectFileSearchEntrySchema = ProjectFileReferenceInputSchema.extend({
  rootLabel: DisplayNameSchema,
  displayName: DisplayNameSchema,
  /** Bei Ordnern 0 — die Größe ergibt sich erst aus den enthaltenen Dateien. */
  size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Direkte Einträge eines Ordners; bei Dateien 0. */
  childCount: z.int().nonnegative().default(0),
  contextEligible: z.boolean(),
  contextUnavailableReason: z.string().trim().min(1).max(500).nullable(),
}).strict();

export const SearchProjectFilesInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    /**
     * Leer ist zulässig, sobald die Anfrage einen Ordner adressiert
     * ("src/"): Dann ist das Ergebnis der Inhalt dieses Ordners.
     */
    query: z.string().trim().max(200).default(""),
    limit: z.int().min(1).max(MAX_PROJECT_FILE_SEARCH_RESULTS).default(MAX_PROJECT_FILE_SEARCH_RESULTS),
  })
  .strict();

export const ProjectFileSearchResultSchema = z
  .object({
    projectId: EntityIdSchema,
    rootRevision: RootRevisionSchema,
    entries: z.array(ProjectFileSearchEntrySchema).max(MAX_PROJECT_FILE_SEARCH_RESULTS),
    truncated: z.boolean(),
  })
  .strict();

export const ProjectFilePromptSnapshotSchema = z
  .object({
    rootId: EntityIdSchema,
    rootLabel: DisplayNameSchema,
    relativePath: ProjectRelativePathSchema,
    displayName: DisplayNameSchema,
    kind: ProjectEntryKindSchema.default("file"),
    /** Nur bei Ordnern: wie viele Dateien tatsächlich mitgegangen sind. */
    fileCount: z.int().nonnegative().optional(),
  })
  .strict();

export type ProjectEntryKind = z.infer<typeof ProjectEntryKindSchema>;
export type ProjectFileReferenceInput = z.input<
  typeof ProjectFileReferenceInputSchema
>;
export type ProjectFileSearchEntry = z.infer<
  typeof ProjectFileSearchEntrySchema
>;
export type SearchProjectFilesInput = z.input<
  typeof SearchProjectFilesInputSchema
>;
export type ProjectFileSearchResult = z.infer<
  typeof ProjectFileSearchResultSchema
>;
export type ProjectFilePromptSnapshot = z.infer<
  typeof ProjectFilePromptSnapshotSchema
>;
