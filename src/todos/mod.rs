use crate::context_attachments::{
    contracts::{
        AddContextFilesInput, AddContextLinkInput, ContextAttachment, ContextAttachmentList,
        ContextAttachmentOrigin, ContextAttachmentScope,
    },
    repository::ContextAttachmentRepository,
    service::ContextAttachmentService,
};
use crate::{
    db::DbPool,
    error::AppError,
    idempotency::{idempotent, ClientRequestRepo},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
pub mod commands;
pub mod subscriptions;
pub use subscriptions::{TodoPush, TodoSubscriptionHub, UnsubscribeTodosInput};

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidResult {
    pub ok: bool,
}

pub const MAX_TODOS_PER_PROJECT: usize = 200;
pub const MAX_TODO_ATTACHMENTS: usize = 20;
pub const MAX_TODO_DESCRIPTION_CHARS: usize = 20_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Todo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub done: bool,
    pub sort_order: usize,
    pub attachments: Vec<ContextAttachment>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoList {
    pub project_id: String,
    pub todos: Vec<Todo>,
    pub open_count: usize,
    pub done_count: usize,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListTodosInput {
    pub project_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTodoInput {
    pub client_request_id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTodoInput {
    pub client_request_id: String,
    pub todo_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub done: Option<bool>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderTodosInput {
    pub client_request_id: String,
    pub project_id: String,
    pub todo_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteTodoInput {
    pub client_request_id: String,
    pub todo_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddTodoFilesInput {
    pub client_request_id: String,
    pub todo_id: String,
    #[serde(default)]
    pub paths: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddTodoLinkInput {
    pub client_request_id: String,
    pub todo_id: String,
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoAttachmentInput {
    pub client_request_id: String,
    pub todo_id: String,
    pub attachment_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareTodoForSessionInput {
    pub client_request_id: String,
    pub todo_id: String,
    pub session_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoPromptDraft {
    pub todo_id: String,
    pub session_id: String,
    pub text: String,
    pub attachment_ids: Vec<String>,
    pub context_attachments: ContextAttachmentList,
}

#[derive(Clone)]
pub struct TodoRepository {
    db: DbPool,
    attachments: ContextAttachmentRepository,
}
#[derive(Clone)]
struct RawTodo {
    id: String,
    project_id: String,
    title: String,
    description: String,
    done: bool,
    sort_order: usize,
    completed_at: Option<String>,
    created_at: String,
    updated_at: String,
}
fn raw_todo(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawTodo> {
    Ok(RawTodo {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        done: row.get::<_, i64>(4)? != 0,
        sort_order: row.get::<_, i64>(5)? as usize,
        completed_at: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}
impl TodoRepository {
    pub fn new(db: DbPool, attachments: ContextAttachmentRepository) -> Self {
        Self { db, attachments }
    }
    fn to_todo(&self, row: RawTodo) -> Result<Todo, AppError> {
        let ids = self.attachment_ids(&row.id)?;
        Ok(Todo {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            description: row.description,
            done: row.done,
            sort_order: row.sort_order,
            attachments: self.attachments.list_by_ids(&ids, None)?,
            completed_at: row.completed_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
    pub fn list(&self, project: &str) -> Result<TodoList, AppError> {
        let c = self.db.connection()?;
        let mut st = c.prepare("SELECT id,project_id,title,description,done,sort_order,completed_at,created_at,updated_at FROM todos WHERE project_id=?1 ORDER BY done,sort_order,created_at")?;
        let rows = st
            .query_map([project], raw_todo)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(st);
        drop(c);
        let todos = rows
            .into_iter()
            .take(MAX_TODOS_PER_PROJECT)
            .map(|r| self.to_todo(r))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TodoList {
            project_id: project.to_owned(),
            open_count: todos.iter().filter(|v| !v.done).count(),
            done_count: todos.iter().filter(|v| v.done).count(),
            todos,
        })
    }
    pub fn get(&self, id: &str) -> Result<Todo, AppError> {
        let c = self.db.connection()?;
        let row = c.query_row("SELECT id,project_id,title,description,done,sort_order,completed_at,created_at,updated_at FROM todos WHERE id=?1", [id], raw_todo).optional()?.ok_or_else(|| AppError::NotFound(format!("Todo {id} was not found")))?;
        drop(c);
        self.to_todo(row)
    }
    pub fn project_id_of(&self, id: &str) -> Result<String, AppError> {
        self.db
            .connection()?
            .query_row("SELECT project_id FROM todos WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Todo {id} was not found")))
    }
    pub fn create(
        &self,
        id: &str,
        project: &str,
        title: &str,
        description: &str,
        at: &str,
    ) -> Result<Todo, AppError> {
        if title.trim().is_empty()
            || title.chars().count() > 200
            || description.chars().count() > MAX_TODO_DESCRIPTION_CHARS
        {
            return Err(AppError::Validation(
                "Todo title or description is invalid".to_owned(),
            ));
        }
        let count: i64 = self.db.connection()?.query_row(
            "SELECT COUNT(*) FROM todos WHERE project_id=?1",
            [project],
            |r| r.get(0),
        )?;
        if count >= MAX_TODOS_PER_PROJECT as i64 {
            return Err(AppError::Conflict(format!(
                "Pro Projekt sind höchstens {MAX_TODOS_PER_PROJECT} Todos möglich."
            )));
        }
        let order: i64 = self.db.connection()?.query_row(
            "SELECT COALESCE(MAX(sort_order),-1)+1 FROM todos WHERE project_id=?1",
            [project],
            |r| r.get(0),
        )?;
        self.db.connection()?.execute("INSERT INTO todos(id,project_id,title,description,done,sort_order,completed_at,created_at,updated_at) VALUES(?1,?2,?3,?4,0,?5,NULL,?6,?6)", params![id, project, title.trim(), description, order, at])?;
        self.get(id)
    }
    pub fn update(&self, input: &UpdateTodoInput, at: &str) -> Result<Todo, AppError> {
        let old = self.get(&input.todo_id)?;
        let done = input.done.unwrap_or(old.done);
        let completed = if done {
            old.completed_at.clone().or_else(|| Some(at.to_owned()))
        } else {
            None
        };
        let title = input.title.as_deref().unwrap_or(&old.title);
        let desc = input.description.as_deref().unwrap_or(&old.description);
        if title.trim().is_empty()
            || title.chars().count() > 200
            || desc.chars().count() > MAX_TODO_DESCRIPTION_CHARS
        {
            return Err(AppError::Validation(
                "Todo title or description is invalid".to_owned(),
            ));
        }
        self.db.connection()?.execute("UPDATE todos SET title=?1,description=?2,done=?3,completed_at=?4,updated_at=?5 WHERE id=?6", params![title.trim(), desc, done as i64, completed, at, input.todo_id])?;
        self.get(&input.todo_id)
    }
    pub fn reorder(&self, project: &str, ids: &[String], at: &str) -> Result<(), AppError> {
        if ids.len() > MAX_TODOS_PER_PROJECT {
            return Err(AppError::Validation("too many todos".to_owned()));
        }
        let known: std::collections::HashSet<String> = {
            let c = self.db.connection()?;
            let mut st = c.prepare("SELECT id FROM todos WHERE project_id=?1")?;
            let values = st
                .query_map([project], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            values
        };
        if ids.iter().any(|id| !known.contains(id)) {
            return Err(AppError::Validation(
                "Mindestens ein Todo gehört nicht zu diesem Projekt.".to_owned(),
            ));
        }
        let c = self.db.connection()?;
        let tx = c.unchecked_transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE todos SET sort_order=?1,updated_at=?2 WHERE id=?3",
                params![index as i64, at, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<String, AppError> {
        let project = self.project_id_of(id)?;
        self.db
            .connection()?
            .execute("DELETE FROM todos WHERE id=?1", [id])?;
        Ok(project)
    }
    pub fn attachment_ids(&self, id: &str) -> Result<Vec<String>, AppError> {
        let c = self.db.connection()?;
        let mut st = c.prepare("SELECT attachment_id FROM todo_attachment_links WHERE todo_id=?1 ORDER BY sort_order,created_at")?;
        let values = st
            .query_map([id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(values)
    }
    pub fn link_attachment(&self, todo: &str, attachment: &str, at: &str) -> Result<(), AppError> {
        let ids = self.attachment_ids(todo)?;
        if ids.iter().any(|id| id == attachment) {
            return Ok(());
        }
        if ids.len() >= MAX_TODO_ATTACHMENTS {
            return Err(AppError::Conflict(format!(
                "Pro Todo sind höchstens {MAX_TODO_ATTACHMENTS} Anhänge möglich."
            )));
        }
        self.db.connection()?.execute("INSERT INTO todo_attachment_links(todo_id,attachment_id,sort_order,created_at) VALUES(?1,?2,?3,?4)", params![todo, attachment, ids.len() as i64, at])?;
        Ok(())
    }
    pub fn unlink_attachment(&self, todo: &str, attachment: &str) -> Result<(), AppError> {
        self.db.connection()?.execute(
            "DELETE FROM todo_attachment_links WHERE todo_id=?1 AND attachment_id=?2",
            params![todo, attachment],
        )?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct TodoService {
    pub repository: TodoRepository,
    pub contexts: ContextAttachmentService,
    pub client_requests: ClientRequestRepo,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}
impl TodoService {
    pub fn new(db: DbPool, contexts: ContextAttachmentService) -> Self {
        Self::with_clock(db, contexts, Arc::new(now_iso))
    }
    pub fn with_clock(
        db: DbPool,
        contexts: ContextAttachmentService,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            repository: TodoRepository::new(db.clone(), contexts.repository.clone()),
            contexts,
            client_requests: ClientRequestRepo::new(db),
            now,
        }
    }
    pub fn list(&self, input: ListTodosInput) -> Result<TodoList, AppError> {
        self.repository.list(&input.project_id)
    }
    pub async fn create(&self, input: CreateTodoInput) -> Result<TodoList, AppError> {
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.create",
            || async {
                self.repository
                    .create(
                        &Uuid::new_v4().to_string(),
                        &input.project_id,
                        &input.title,
                        &input.description,
                        &(self.now)(),
                    )
                    .and_then(|_| self.repository.list(&input.project_id))
            },
        )
        .await
    }
    pub async fn update(&self, input: UpdateTodoInput) -> Result<TodoList, AppError> {
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.update",
            || async {
                let project = self.repository.project_id_of(&input.todo_id)?;
                self.repository
                    .update(&input, &(self.now)())
                    .and_then(|_| self.repository.list(&project))
            },
        )
        .await
    }
    pub async fn reorder(&self, input: ReorderTodosInput) -> Result<TodoList, AppError> {
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.reorder",
            || async {
                self.repository
                    .reorder(&input.project_id, &input.todo_ids, &(self.now)())
                    .and_then(|_| self.repository.list(&input.project_id))
            },
        )
        .await
    }
    pub async fn delete(&self, input: DeleteTodoInput) -> Result<TodoList, AppError> {
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.delete",
            || async {
                let project = self.repository.project_id_of(&input.todo_id)?;
                self.repository
                    .delete(&input.todo_id)
                    .and_then(|_| self.repository.list(&project))
            },
        )
        .await
    }
    pub async fn add_files(&self, input: AddTodoFilesInput) -> Result<TodoList, AppError> {
        let todo = input.todo_id.clone();
        let context_request = format!("{}:context", input.client_request_id);
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.add-files",
            || async {
                let project = self.repository.project_id_of(&todo)?;
                let stored = self
                    .contexts
                    .ingest_files_request(AddContextFilesInput {
                        client_request_id: context_request.clone(),
                        project_id: project.clone(),
                        scope: ContextAttachmentScope::Project,
                        session_id: None,
                        paths: input.paths.clone(),
                        origin: ContextAttachmentOrigin::Chat,
                        default_include: Some(false),
                    })
                    .await?;
                for value in stored {
                    self.repository
                        .link_attachment(&todo, &value.public.id, &(self.now)())?;
                }
                self.repository.list(&project)
            },
        )
        .await
    }
    pub async fn add_link(&self, input: AddTodoLinkInput) -> Result<TodoList, AppError> {
        let todo = input.todo_id.clone();
        let context_request = format!("{}:context", input.client_request_id);
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.add-link",
            || async {
                let project = self.repository.project_id_of(&todo)?;
                let value = self
                    .contexts
                    .ingest_link_request(AddContextLinkInput {
                        client_request_id: context_request.clone(),
                        project_id: project.clone(),
                        scope: ContextAttachmentScope::Project,
                        session_id: None,
                        url: input.url.clone(),
                        title: input.title.clone(),
                        origin: ContextAttachmentOrigin::Chat,
                        default_include: Some(false),
                    })
                    .await?;
                self.repository
                    .link_attachment(&todo, &value.public.id, &(self.now)())?;
                self.repository.list(&project)
            },
        )
        .await
    }
    pub async fn attach(&self, input: TodoAttachmentInput) -> Result<TodoList, AppError> {
        self.mutate_attachment(input, "todos.attach", true).await
    }
    pub async fn detach(&self, input: TodoAttachmentInput) -> Result<TodoList, AppError> {
        self.mutate_attachment(input, "todos.detach", false).await
    }
    async fn mutate_attachment(
        &self,
        input: TodoAttachmentInput,
        operation: &str,
        attach: bool,
    ) -> Result<TodoList, AppError> {
        let todo = input.todo_id.clone();
        let attachment = input.attachment_id.clone();
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            operation,
            || async {
                let project = self.repository.project_id_of(&todo)?;
                let owner = self
                    .contexts
                    .repository
                    .get_internal(&attachment, None)?
                    .public
                    .project_id;
                if owner != project {
                    return Err(AppError::Validation(
                        "Der Anhang gehört nicht zum Projekt.".to_owned(),
                    ));
                }
                if attach {
                    self.repository
                        .link_attachment(&todo, &attachment, &(self.now)())?;
                } else {
                    self.repository.unlink_attachment(&todo, &attachment)?;
                }
                self.repository.list(&project)
            },
        )
        .await
    }
    pub async fn prepare_for_session(
        &self,
        input: PrepareTodoForSessionInput,
    ) -> Result<TodoPromptDraft, AppError> {
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "todos.prepare-for-session",
            || async { self.prepare_for_session_unchecked(input.clone()).await },
        )
        .await
    }
    async fn prepare_for_session_unchecked(
        &self,
        input: PrepareTodoForSessionInput,
    ) -> Result<TodoPromptDraft, AppError> {
        let todo = self.repository.get(&input.todo_id)?;
        let owner: Option<String> = self
            .contexts
            .repository
            .database()
            .connection()?
            .query_row(
                "SELECT project_id FROM sessions WHERE id=?1",
                [&input.session_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(&todo.project_id) {
            return Err(AppError::Validation(
                "Die Session gehört nicht zum Projekt.".to_owned(),
            ));
        }
        let ids = self.repository.attachment_ids(&todo.id)?;
        self.contexts
            .repository
            .set_inclusion(&input.session_id, &ids, true, &(self.now)())?;
        let context = self
            .contexts
            .repository
            .list(&todo.project_id, Some(&input.session_id))?;
        let text = if todo.description.trim().is_empty() {
            todo.title.clone()
        } else {
            format!("{}\n\n{}", todo.title, todo.description)
        };
        Ok(TodoPromptDraft {
            todo_id: todo.id,
            session_id: input.session_id,
            text,
            attachment_ids: ids,
            context_attachments: context,
        })
    }
}
fn now_iso() -> String {
    rfc3339_now()
}
fn rfc3339_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86_400;
    let mut year = 1970u64;
    let mut remaining = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for length in lengths {
        if remaining < length {
            break;
        }
        remaining -= length;
        month += 1;
    }
    let day = remaining + 1;
    let hour = (seconds % 86_400) / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod repository_tests {
    use super::TodoRepository;
    use crate::context_attachments::ContextAttachmentRepository;
    use crate::db::DbPool;

    #[test]
    fn list_releases_connection_before_loading_attachment_rows() {
        let db = DbPool::open_in_memory().unwrap();
        {
            let connection = db.connection().unwrap();
            let transaction = connection.unchecked_transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO projects(id,name,primary_root_id,root_fingerprint,created_at,updated_at) VALUES('project','Project','root',printf('%064d',0),'now','now')",
                    [],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO project_roots(id,project_id,kind,path,real_path,label,sort_order,created_at,updated_at) VALUES('root','project','primary','/tmp','/tmp','Project',0,'now','now')",
                    [],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO todos(id,project_id,title,description,done,sort_order,created_at,updated_at) VALUES('todo','project','Todo','',0,0,'now','now')",
                [],
            )
            .unwrap();
        let repository = TodoRepository::new(db.clone(), ContextAttachmentRepository::new(db));
        let started = std::time::Instant::now();
        let list = repository.list("project").unwrap();
        assert_eq!(list.todos.len(), 1);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
