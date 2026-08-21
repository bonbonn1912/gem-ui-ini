import { z } from "zod";

export const RawGitLabUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().trim().min(1),
  name: z.string().trim().min(1),
  avatar_url: z.string().nullable().optional(),
});

export const RawGitLabPersonalAccessTokenSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  expires_at: z.string().nullable().optional(),
  active: z.boolean().optional(),
  revoked: z.boolean().optional(),
});

export const RawGitLabProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  path: z.string(),
  path_with_namespace: z.string(),
  web_url: z.string(),
  default_branch: z.string().optional(),
});

export const RawGitLabDiffRefsSchema = z.object({
  base_sha: z.string().nullable().optional(),
  start_sha: z.string().nullable().optional(),
  head_sha: z.string().nullable().optional(),
});

export const RawGitLabMergeRequestSchema = z.object({
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  project_id: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  web_url: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  sha: z.string(),
  diff_refs: RawGitLabDiffRefsSchema.optional(),
  author: RawGitLabUserSchema,
  user_notes_count: z.number().int().nonnegative().optional(),
  updated_at: z.string(),
});

export const RawGitLabLineRangeSchema = z.object({
  start: z.object({
    line_code: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    old_line: z.number().nullable().optional(),
    new_line: z.number().nullable().optional(),
  }).optional(),
  end: z.object({
    line_code: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    old_line: z.number().nullable().optional(),
    new_line: z.number().nullable().optional(),
  }).optional(),
});

export const RawGitLabPositionSchema = z.object({
  position_type: z.string().optional(),
  base_sha: z.string().nullable().optional(),
  start_sha: z.string().nullable().optional(),
  head_sha: z.string().nullable().optional(),
  old_path: z.string().nullable().optional(),
  new_path: z.string().nullable().optional(),
  old_line: z.number().nullable().optional(),
  new_line: z.number().nullable().optional(),
  line_range: RawGitLabLineRangeSchema.nullable().optional(),
});

export const RawGitLabDiscussionNoteSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().nullable().optional(),
  body: z.string(),
  author: RawGitLabUserSchema,
  created_at: z.string(),
  updated_at: z.string(),
  system: z.boolean().optional(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  resolved_by: RawGitLabUserSchema.nullable().optional(),
  position: RawGitLabPositionSchema.nullable().optional(),
});

export const RawGitLabDiscussionSchema = z.object({
  id: z.string().min(1),
  individual_note: z.boolean().optional(),
  notes: z.array(RawGitLabDiscussionNoteSchema),
});

export const RawGitLabFileSchema = z.object({
  file_name: z.string(),
  file_path: z.string(),
  size: z.number().int().nonnegative(),
  encoding: z.string(),
  content: z.string(),
  ref: z.string(),
  blob_id: z.string(),
  commit_id: z.string(),
});
