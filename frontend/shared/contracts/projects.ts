import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  IsoTimestampSchema,
  RootFingerprintSchema,
  RootRevisionSchema,
} from "./common";

export const MAX_ADDITIONAL_ROOTS = 5;

export const ProjectApprovalModeStateSchema = z.enum([
  "gemini_default",
  "available",
  "unavailable",
]);

export const ProjectApprovalModeSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000).nullable(),
    unrestricted: z.boolean(),
  })
  .strict();

export const ProjectRootKindSchema = z.enum(["primary", "additional"]);

export const ProjectRootSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    kind: ProjectRootKindSchema,
    path: FileSystemPathSchema,
    realPath: FileSystemPathSchema,
    label: DisplayNameSchema,
    sortOrder: z.int().min(0).max(MAX_ADDITIONAL_ROOTS),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((root, context) => {
    if (root.kind === "primary" && root.sortOrder !== 0) {
      context.addIssue({
        code: "custom",
        path: ["sortOrder"],
        message: "The primary root must have sortOrder 0",
      });
    }

    if (root.kind === "additional" && root.sortOrder === 0) {
      context.addIssue({
        code: "custom",
        path: ["sortOrder"],
        message: "Additional roots must have a positive sortOrder",
      });
    }
  });

export const AppProjectSchema = z
  .object({
    id: EntityIdSchema,
    name: DisplayNameSchema,
    primaryRootId: EntityIdSchema,
    rootRevision: RootRevisionSchema,
    rootFingerprint: RootFingerprintSchema,
    approvalModeId: z.string().trim().min(1).max(100).nullable(),
    approvalModeState: ProjectApprovalModeStateSchema,
    archived: z.boolean(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const ProjectWithRootsSchema = AppProjectSchema.extend({
  roots: z.array(ProjectRootSchema).min(1).max(MAX_ADDITIONAL_ROOTS + 1),
})
  .strict()
  .superRefine((project, context) => {
    const primaryRoots = project.roots.filter((root) => root.kind === "primary");
    if (primaryRoots.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["roots"],
        message: "A project must contain exactly one primary root",
      });
      return;
    }

    if (primaryRoots[0]?.id !== project.primaryRootId) {
      context.addIssue({
        code: "custom",
        path: ["primaryRootId"],
        message: "primaryRootId must reference the primary root",
      });
    }

    const additionalCount = project.roots.length - 1;
    if (additionalCount > MAX_ADDITIONAL_ROOTS) {
      context.addIssue({
        code: "custom",
        path: ["roots"],
        message: `A project supports at most ${MAX_ADDITIONAL_ROOTS} additional roots`,
      });
    }

    const realPaths = new Set(project.roots.map((root) => root.realPath));
    if (realPaths.size !== project.roots.length) {
      context.addIssue({
        code: "custom",
        path: ["roots"],
        message: "Project root real paths must be unique",
      });
    }
  });

export const ProjectRootCandidateSchema = z
  .object({
    path: FileSystemPathSchema,
    label: DisplayNameSchema.optional(),
  })
  .strict();

export const CreateProjectInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    name: DisplayNameSchema,
    primaryRootPath: FileSystemPathSchema,
    additionalRootPaths: z
      .array(FileSystemPathSchema)
      .max(MAX_ADDITIONAL_ROOTS)
      .default([]),
  })
  .strict();

export const RenameProjectInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    name: DisplayNameSchema,
  })
  .strict();

export const ArchiveProjectInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    archived: z.boolean(),
  })
  .strict();

export const SetProjectRootsInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    additionalRootPaths: z
      .array(FileSystemPathSchema)
      .max(MAX_ADDITIONAL_ROOTS),
  })
  .strict();

export const DeleteProjectInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
  })
  .strict();

export const GetProjectInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export const ReauthorizeProjectRootInputSchema = z
  .object({
    projectId: EntityIdSchema,
    rootId: EntityIdSchema,
  })
  .strict();

export const ProjectRootReauthorizationResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("authorized"),
        root: ProjectRootSchema,
      })
      .strict(),
    z.object({ status: z.literal("cancelled") }).strict(),
  ],
);

export const ListProjectsInputSchema = z
  .object({
    includeArchived: z.boolean().default(false),
  })
  .strict();

export const GetProjectApprovalPolicyInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export const SetProjectApprovalPolicyInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    modeId: z.string().trim().min(1).max(100).nullable(),
    confirmUnrestricted: z.boolean().default(false),
  })
  .strict();

export const ProjectApprovalPolicySchema = z
  .object({
    projectId: EntityIdSchema,
    modeId: z.string().trim().min(1).max(100).nullable(),
    state: ProjectApprovalModeStateSchema,
    currentModeId: z.string().trim().min(1).max(100).nullable(),
    availableModes: z.array(ProjectApprovalModeSchema).max(50),
    message: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

export const ProjectAccessSchema = z
  .object({
    projectId: EntityIdSchema,
    rootRevision: RootRevisionSchema,
    rootFingerprint: RootFingerprintSchema,
    primaryRoot: ProjectRootSchema,
    additionalRoots: z.array(ProjectRootSchema).max(MAX_ADDITIONAL_ROOTS),
  })
  .strict()
  .superRefine((access, context) => {
    if (access.primaryRoot.kind !== "primary") {
      context.addIssue({
        code: "custom",
        path: ["primaryRoot", "kind"],
        message: "primaryRoot must have kind primary",
      });
    }

    if (access.primaryRoot.projectId !== access.projectId) {
      context.addIssue({
        code: "custom",
        path: ["primaryRoot", "projectId"],
        message: "The primary root must belong to the project",
      });
    }

    for (const [index, root] of access.additionalRoots.entries()) {
      if (root.kind !== "additional" || root.projectId !== access.projectId) {
        context.addIssue({
          code: "custom",
          path: ["additionalRoots", index],
          message: "Every additional root must belong to the project",
        });
      }
    }
  });

export type ProjectRootKind = z.infer<typeof ProjectRootKindSchema>;
export type ProjectRoot = z.infer<typeof ProjectRootSchema>;
export type AppProject = z.infer<typeof AppProjectSchema>;
export type ProjectWithRoots = z.infer<typeof ProjectWithRootsSchema>;
export type ProjectRootCandidate = z.infer<typeof ProjectRootCandidateSchema>;
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;
export type RenameProjectInput = z.input<typeof RenameProjectInputSchema>;
export type ArchiveProjectInput = z.input<typeof ArchiveProjectInputSchema>;
export type SetProjectRootsInput = z.input<typeof SetProjectRootsInputSchema>;
export type DeleteProjectInput = z.input<typeof DeleteProjectInputSchema>;
export type GetProjectInput = z.input<typeof GetProjectInputSchema>;
export type ReauthorizeProjectRootInput = z.input<
  typeof ReauthorizeProjectRootInputSchema
>;
export type ProjectRootReauthorizationResult = z.infer<
  typeof ProjectRootReauthorizationResultSchema
>;
export type ListProjectsInput = z.input<typeof ListProjectsInputSchema>;
export type GetProjectApprovalPolicyInput = z.input<
  typeof GetProjectApprovalPolicyInputSchema
>;
export type SetProjectApprovalPolicyInput = z.input<
  typeof SetProjectApprovalPolicyInputSchema
>;
export type ProjectApprovalModeState = z.infer<
  typeof ProjectApprovalModeStateSchema
>;
export type ProjectApprovalMode = z.infer<typeof ProjectApprovalModeSchema>;
export type ProjectApprovalPolicy = z.infer<
  typeof ProjectApprovalPolicySchema
>;
export type ProjectAccess = z.infer<typeof ProjectAccessSchema>;
