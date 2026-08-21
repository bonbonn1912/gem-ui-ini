import {
  MAX_TODOS_PER_PROJECT,
  MAX_TODO_ATTACHMENTS,
  TodoListSchema,
  TodoSchema,
  type Todo,
  type TodoList,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageNotFoundError } from "../errors";
import type { ContextAttachmentRepository } from "./context-attachment-repository";

type TodoRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  done: number;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateTodoRow = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  createdAt: string;
};

export type UpdateTodoRow = {
  todoId: string;
  title?: string;
  description?: string;
  done?: boolean;
  updatedAt: string;
};

/**
 * Todos live on the project and carry their attachments as links into the
 * project's context attachments, so the attachment payload is read through the
 * context attachment repository instead of being duplicated here.
 */
export class TodoRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly attachments: ContextAttachmentRepository,
  ) {}

  list(projectId: string): TodoList {
    const rows = this.database.prepare(
      `SELECT id, project_id, title, description, done, sort_order,
              completed_at, created_at, updated_at
       FROM todos
       WHERE project_id = ?
       ORDER BY done, sort_order, created_at`,
    ).all(projectId) as TodoRow[];
    const todos = rows.slice(0, MAX_TODOS_PER_PROJECT).map((row) => this.#toTodo(row));
    return TodoListSchema.parse({
      projectId,
      todos,
      openCount: todos.filter((todo) => !todo.done).length,
      doneCount: todos.filter((todo) => todo.done).length,
    });
  }

  get(todoId: string): Todo {
    return this.#toTodo(this.#requireRow(todoId));
  }

  projectIdOf(todoId: string): string {
    return this.#requireRow(todoId).project_id;
  }

  create(input: CreateTodoRow): Todo {
    const count = this.#countForProject(input.projectId);
    if (count >= MAX_TODOS_PER_PROJECT) {
      throw new Error(`Pro Projekt sind höchstens ${MAX_TODOS_PER_PROJECT} Todos möglich.`);
    }
    const sortOrder = this.#nextSortOrder(input.projectId);
    this.database.prepare(
      `INSERT INTO todos (
         id, project_id, title, description, done, sort_order,
         completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
    ).run(
      input.id,
      input.projectId,
      input.title,
      input.description,
      sortOrder,
      input.createdAt,
      input.createdAt,
    );
    return this.get(input.id);
  }

  update(input: UpdateTodoRow): Todo {
    const existing = this.#requireRow(input.todoId);
    const done = input.done ?? existing.done === 1;
    // The completion timestamp is derived, never supplied: it is only rewritten
    // when the flag actually flips, so re-saving a finished todo keeps the
    // moment it was finished.
    const completedAt = done
      ? existing.completed_at ?? input.updatedAt
      : null;
    this.database.prepare(
      `UPDATE todos
       SET title = ?, description = ?, done = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? existing.title,
      input.description ?? existing.description,
      done ? 1 : 0,
      completedAt,
      input.updatedAt,
      input.todoId,
    );
    return this.get(input.todoId);
  }

  reorder(projectId: string, todoIds: readonly string[], updatedAt: string): void {
    const known = new Set(
      (this.database.prepare("SELECT id FROM todos WHERE project_id = ?")
        .all(projectId) as Array<{ id: string }>).map((row) => row.id),
    );
    if (todoIds.some((todoId) => !known.has(todoId))) {
      throw new Error("Mindestens ein Todo gehört nicht zu diesem Projekt.");
    }
    this.database.transaction(() => {
      todoIds.forEach((todoId, index) => {
        this.database.prepare(
          "UPDATE todos SET sort_order = ?, updated_at = ? WHERE id = ?",
        ).run(index, updatedAt, todoId);
      });
    })();
  }

  delete(todoId: string): string {
    const row = this.#requireRow(todoId);
    this.database.prepare("DELETE FROM todos WHERE id = ?").run(todoId);
    return row.project_id;
  }

  attachmentIds(todoId: string): string[] {
    const rows = this.database.prepare(
      `SELECT attachment_id FROM todo_attachment_links
       WHERE todo_id = ? ORDER BY sort_order, created_at`,
    ).all(todoId) as Array<{ attachment_id: string }>;
    return rows.map((row) => row.attachment_id);
  }

  linkAttachment(todoId: string, attachmentId: string, createdAt: string): void {
    const existing = this.attachmentIds(todoId);
    if (existing.includes(attachmentId)) return;
    if (existing.length >= MAX_TODO_ATTACHMENTS) {
      throw new Error(`Pro Todo sind höchstens ${MAX_TODO_ATTACHMENTS} Anhänge möglich.`);
    }
    this.database.prepare(
      `INSERT INTO todo_attachment_links (todo_id, attachment_id, sort_order, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(todoId, attachmentId, existing.length, createdAt);
  }

  unlinkAttachment(todoId: string, attachmentId: string): void {
    this.database.prepare(
      "DELETE FROM todo_attachment_links WHERE todo_id = ? AND attachment_id = ?",
    ).run(todoId, attachmentId);
  }

  #toTodo(row: TodoRow): Todo {
    return TodoSchema.parse({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      done: row.done === 1,
      sortOrder: row.sort_order,
      attachments: this.attachments.listByIds(this.attachmentIds(row.id)),
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #requireRow(todoId: string): TodoRow {
    const row = this.database.prepare(
      `SELECT id, project_id, title, description, done, sort_order,
              completed_at, created_at, updated_at
       FROM todos WHERE id = ?`,
    ).get(todoId) as TodoRow | undefined;
    if (!row) throw new StorageNotFoundError("Todo", todoId);
    return row;
  }

  #countForProject(projectId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM todos WHERE project_id = ?",
    ).get(projectId) as { count: number };
    return row.count;
  }

  #nextSortOrder(projectId: string): number {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM todos WHERE project_id = ?",
    ).get(projectId) as { value: number };
    return row.value;
  }
}
