import { randomUUID } from "node:crypto";

import {
  AddTodoFilesInputSchema,
  AddTodoLinkInputSchema,
  AttachTodoAttachmentInputSchema,
  CreateTodoInputSchema,
  DeleteTodoInputSchema,
  DetachTodoAttachmentInputSchema,
  ListTodosInputSchema,
  PrepareTodoForSessionInputSchema,
  ReorderTodosInputSchema,
  TodoPromptDraftSchema,
  UpdateTodoInputSchema,
  type AddTodoFilesInput,
  type AddTodoLinkInput,
  type AttachTodoAttachmentInput,
  type CreateTodoInput,
  type DeleteTodoInput,
  type DetachTodoAttachmentInput,
  type ListTodosInput,
  type PrepareTodoForSessionInput,
  type ReorderTodosInput,
  type Todo,
  type TodoList,
  type TodoPromptDraft,
  type UpdateTodoInput,
} from "../../shared";
import type { ContextAttachmentService } from "../context-attachments";
import type { ProjectService } from "../projects";
import type { SessionRepository, TodoRepository } from "../storage";

type ChangeListener = (projectId: string) => void;

/**
 * Todos are prompt drafts that belong to a project. Their attachments are
 * project context attachments the todo points at, which is what makes handing a
 * todo to a session cheap: nothing is copied, the session simply selects the
 * attachments the todo names.
 */
export class TodoService {
  readonly #listeners = new Set<ChangeListener>();
  readonly #unsubscribeAttachments: () => void;

  constructor(
    private readonly repository: TodoRepository,
    private readonly contextAttachments: ContextAttachmentService,
    private readonly projects: ProjectService,
    private readonly sessions: SessionRepository,
  ) {
    // An attachment that finishes text extraction or gets a link preview
    // changes what the todo shows, so attachment changes are todo changes.
    this.#unsubscribeAttachments = contextAttachments.subscribe((projectId) =>
      this.#emit(projectId),
    );
  }

  dispose(): void {
    this.#unsubscribeAttachments();
    this.#listeners.clear();
  }

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(input: ListTodosInput): TodoList {
    const parsed = ListTodosInputSchema.parse(input);
    this.projects.get(parsed.projectId);
    return this.repository.list(parsed.projectId);
  }

  create(input: CreateTodoInput): TodoList {
    const parsed = CreateTodoInputSchema.parse(input);
    this.projects.get(parsed.projectId);
    this.repository.create({
      id: randomUUID(),
      projectId: parsed.projectId,
      title: parsed.title,
      description: parsed.description,
      createdAt: new Date().toISOString(),
    });
    return this.#changed(parsed.projectId);
  }

  update(input: UpdateTodoInput): TodoList {
    const parsed = UpdateTodoInputSchema.parse(input);
    const projectId = this.repository.projectIdOf(parsed.todoId);
    this.repository.update({
      todoId: parsed.todoId,
      title: parsed.title,
      description: parsed.description,
      done: parsed.done,
      updatedAt: new Date().toISOString(),
    });
    return this.#changed(projectId);
  }

  reorder(input: ReorderTodosInput): TodoList {
    const parsed = ReorderTodosInputSchema.parse(input);
    this.projects.get(parsed.projectId);
    this.repository.reorder(parsed.projectId, parsed.todoIds, new Date().toISOString());
    return this.#changed(parsed.projectId);
  }

  delete(input: DeleteTodoInput): TodoList {
    const parsed = DeleteTodoInputSchema.parse(input);
    const projectId = this.repository.delete(parsed.todoId);
    return this.#changed(projectId);
  }

  async addFiles(input: AddTodoFilesInput): Promise<TodoList> {
    const parsed = AddTodoFilesInputSchema.parse(input);
    const projectId = this.repository.projectIdOf(parsed.todoId);
    const attachments = await this.contextAttachments.ingestFiles({
      clientRequestId: randomUUID(),
      projectId,
      scope: "project",
      sessionId: null,
      paths: parsed.paths,
      origin: "manual",
    });
    const linkedAt = new Date().toISOString();
    for (const attachment of attachments) {
      this.repository.linkAttachment(parsed.todoId, attachment.id, linkedAt);
    }
    return this.#changed(projectId);
  }

  async addLink(input: AddTodoLinkInput): Promise<TodoList> {
    const parsed = AddTodoLinkInputSchema.parse(input);
    const projectId = this.repository.projectIdOf(parsed.todoId);
    const attachment = await this.contextAttachments.ingestLink({
      clientRequestId: randomUUID(),
      projectId,
      scope: "project",
      sessionId: null,
      url: parsed.url,
      title: parsed.title,
      origin: "manual",
    });
    this.repository.linkAttachment(parsed.todoId, attachment.id, new Date().toISOString());
    return this.#changed(projectId);
  }

  attachAttachment(input: AttachTodoAttachmentInput): TodoList {
    const parsed = AttachTodoAttachmentInputSchema.parse(input);
    const projectId = this.repository.projectIdOf(parsed.todoId);
    const attachment = this.contextAttachments.getStored(parsed.attachmentId);
    if (attachment.projectId !== projectId) {
      throw new Error("Der Anhang gehört nicht zu diesem Projekt.");
    }
    if (attachment.scope !== "project") {
      throw new Error("Nur Projektanhänge können einem Todo zugeordnet werden.");
    }
    this.repository.linkAttachment(parsed.todoId, parsed.attachmentId, new Date().toISOString());
    return this.#changed(projectId);
  }

  detachAttachment(input: DetachTodoAttachmentInput): TodoList {
    const parsed = DetachTodoAttachmentInputSchema.parse(input);
    const projectId = this.repository.projectIdOf(parsed.todoId);
    this.repository.unlinkAttachment(parsed.todoId, parsed.attachmentId);
    return this.#changed(projectId);
  }

  /**
   * Hands a todo to a session: its attachments become part of that session's
   * context selection and the caller receives the prompt text to put into the
   * composer. The text is the todo verbatim — nothing is added around it,
   * because what the user wrote is what they want to send.
   */
  prepareForSession(input: PrepareTodoForSessionInput): TodoPromptDraft {
    const parsed = PrepareTodoForSessionInputSchema.parse(input);
    const todo = this.repository.get(parsed.todoId);
    const session = this.sessions.getById(parsed.sessionId);
    if (session.projectId !== todo.projectId) {
      throw new Error("Die Session gehört nicht zum Projekt dieses Todos.");
    }
    const attachmentIds = todo.attachments.map((attachment) => attachment.id);
    const contextAttachments = attachmentIds.length
      ? this.contextAttachments.setInclusion({
          clientRequestId: randomUUID(),
          sessionId: session.id,
          attachmentIds,
          included: true,
        })
      : this.contextAttachments.list({
          projectId: todo.projectId,
          sessionId: session.id,
        });
    return TodoPromptDraftSchema.parse({
      todoId: todo.id,
      sessionId: session.id,
      text: promptTextOf(todo),
      attachmentIds,
      contextAttachments,
    });
  }

  #changed(projectId: string): TodoList {
    this.#emit(projectId);
    return this.repository.list(projectId);
  }

  #emit(projectId: string): void {
    for (const listener of this.#listeners) listener(projectId);
  }
}

export function promptTextOf(todo: Todo): string {
  const description = todo.description.trim();
  return description ? `${todo.title}\n\n${description}` : todo.title;
}
