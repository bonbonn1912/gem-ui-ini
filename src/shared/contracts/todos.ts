import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  IsoTimestampSchema,
  VoidResultSchema,
} from "./common";
import {
  ContextAttachmentListSchema,
  ContextAttachmentSchema,
} from "./context-attachments";

export const MAX_TODOS_PER_PROJECT = 200;
export const MAX_TODO_ATTACHMENTS = 20;
export const MAX_TODO_DESCRIPTION_CHARS = 20_000;

/**
 * A todo is a saved prompt draft: a title, a longer description and the
 * attachments that belong to the request. Todos always live on the project,
 * never on a session, so the same draft can be pushed into any session of the
 * project — or into a brand new one.
 *
 * The attachments are ordinary project context attachments that are linked to
 * the todo. Sending the todo therefore does not copy anything: it only selects
 * those attachments for the target session.
 */
export const TodoSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    title: DisplayNameSchema,
    description: z.string().max(MAX_TODO_DESCRIPTION_CHARS),
    done: z.boolean(),
    sortOrder: z.int().nonnegative(),
    attachments: z.array(ContextAttachmentSchema).max(MAX_TODO_ATTACHMENTS),
    completedAt: IsoTimestampSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.done !== (value.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "done must match completedAt",
        path: ["completedAt"],
      });
    }
  });

export const TodoListSchema = z
  .object({
    projectId: EntityIdSchema,
    todos: z.array(TodoSchema).max(MAX_TODOS_PER_PROJECT),
    openCount: z.int().nonnegative(),
    doneCount: z.int().nonnegative(),
  })
  .strict();

export const ListTodosInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export const CreateTodoInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    title: DisplayNameSchema,
    description: z.string().max(MAX_TODO_DESCRIPTION_CHARS).default(""),
  })
  .strict();

export const UpdateTodoInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
    title: DisplayNameSchema.optional(),
    description: z.string().max(MAX_TODO_DESCRIPTION_CHARS).optional(),
    done: z.boolean().optional(),
  })
  .strict();

export const ReorderTodosInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    todoIds: z.array(EntityIdSchema).max(MAX_TODOS_PER_PROJECT),
  })
  .strict();

export const DeleteTodoInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
  })
  .strict();

export const AddTodoFilesInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
    paths: z.array(FileSystemPathSchema).max(20).default([]),
  })
  .strict();

export const AddTodoLinkInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
    url: z.url(),
    title: DisplayNameSchema.optional(),
  })
  .strict();

/**
 * Detaching keeps the attachment in the project — it was added to the project
 * scope and other todos or sessions may still use it. Only the link between
 * this todo and the attachment is dropped.
 */
export const DetachTodoAttachmentInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
    attachmentId: EntityIdSchema,
  })
  .strict();

export const AttachTodoAttachmentInputSchema = DetachTodoAttachmentInputSchema;

export const PrepareTodoForSessionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    todoId: EntityIdSchema,
    sessionId: EntityIdSchema,
  })
  .strict();

/**
 * Everything the renderer needs to hand a todo to a session: the prompt text to
 * put into the composer and the attachment list of that session, already
 * updated so the todo's attachments are selected.
 */
export const TodoPromptDraftSchema = z
  .object({
    todoId: EntityIdSchema,
    sessionId: EntityIdSchema,
    text: z.string().min(1),
    attachmentIds: z.array(EntityIdSchema).max(MAX_TODO_ATTACHMENTS),
    contextAttachments: ContextAttachmentListSchema,
  })
  .strict();

export const TodoSubscriptionResultSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    list: TodoListSchema,
  })
  .strict();

export const TodoPushSchema = TodoSubscriptionResultSchema;

export const UnsubscribeTodosInputSchema = z
  .object({
    subscriptionId: EntityIdSchema,
  })
  .strict();

export type Todo = z.infer<typeof TodoSchema>;
export type TodoList = z.infer<typeof TodoListSchema>;
export type TodoPromptDraft = z.infer<typeof TodoPromptDraftSchema>;
export type ListTodosInput = z.input<typeof ListTodosInputSchema>;
export type CreateTodoInput = z.input<typeof CreateTodoInputSchema>;
export type UpdateTodoInput = z.input<typeof UpdateTodoInputSchema>;
export type ReorderTodosInput = z.input<typeof ReorderTodosInputSchema>;
export type DeleteTodoInput = z.input<typeof DeleteTodoInputSchema>;
export type AddTodoFilesInput = z.input<typeof AddTodoFilesInputSchema>;
export type AddTodoLinkInput = z.input<typeof AddTodoLinkInputSchema>;
export type DetachTodoAttachmentInput = z.input<typeof DetachTodoAttachmentInputSchema>;
export type AttachTodoAttachmentInput = z.input<typeof AttachTodoAttachmentInputSchema>;
export type PrepareTodoForSessionInput = z.input<typeof PrepareTodoForSessionInputSchema>;
export type UnsubscribeTodosInput = z.input<typeof UnsubscribeTodosInputSchema>;

export { VoidResultSchema };
