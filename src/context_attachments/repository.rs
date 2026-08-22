use super::contracts::*;
use crate::{db::DbPool, error::AppError};
use rusqlite::{params, OptionalExtension};
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct StoredContextAttachment {
    pub public: ContextAttachment,
    pub dedupe_key: String,
    pub default_include: bool,
    pub session_key: String,
    pub storage_dir: Option<String>,
    pub file_name: Option<String>,
    pub preview_image_file: Option<String>,
}
#[derive(Clone)]
pub struct ContextAttachmentRepository {
    db: DbPool,
}
#[derive(Clone, Debug)]
pub struct FileInsert {
    pub id: String,
    pub project_id: String,
    pub scope: ContextAttachmentScope,
    pub session_id: Option<String>,
    pub title: String,
    pub origin: ContextAttachmentOrigin,
    pub display_name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub storage_dir: String,
    pub file_name: String,
    pub default_include: bool,
    pub created_at: String,
}
#[derive(Clone, Debug)]
pub struct LinkInsert {
    pub id: String,
    pub project_id: String,
    pub scope: ContextAttachmentScope,
    pub session_id: Option<String>,
    pub title: String,
    pub origin: ContextAttachmentOrigin,
    pub url: String,
    pub normalized_url: String,
    pub host: String,
    pub default_include: bool,
    pub created_at: String,
}

const SELECT: &str = "SELECT a.id,a.project_id,a.scope,a.session_id,a.session_key,a.kind,a.origin,a.title,a.note,a.dedupe_key,a.sort_order,a.default_include,a.created_at,a.updated_at,COALESCE(sel.included,a.default_include),f.display_name,f.mime_type,f.size,f.sha256,f.storage_dir,f.file_name,f.extraction_state,f.extracted_chars,f.page_count,f.extraction_error,l.url,l.host,l.preview_state,l.preview_title,l.preview_description,l.preview_site_name,l.preview_image_file,l.preview_error,l.fetched_at FROM context_attachments a LEFT JOIN context_attachment_files f ON f.attachment_id=a.id LEFT JOIN context_attachment_links l ON l.attachment_id=a.id LEFT JOIN context_attachment_selections sel ON sel.attachment_id=a.id AND sel.session_id=?1";

impl ContextAttachmentRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
    pub fn database(&self) -> DbPool {
        self.db.clone()
    }
    pub fn list(
        &self,
        project_id: &str,
        session_id: Option<&str>,
    ) -> Result<ContextAttachmentList, AppError> {
        let connection = self.db.connection()?;
        let mut statement = connection.prepare(&format!("{SELECT} WHERE a.project_id=?2 AND (a.scope='project' OR (?3 IS NOT NULL AND a.session_id=?4)) ORDER BY CASE a.scope WHEN 'project' THEN 0 ELSE 1 END,a.sort_order,a.created_at"))?;
        let rows = statement
            .query_map(
                params![session_id, project_id, session_id, session_id],
                parse_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut project = Vec::new();
        let mut session = Vec::new();
        for row in rows {
            if row.public.scope == ContextAttachmentScope::Project {
                if project.len() < MAX_CONTEXT_ATTACHMENTS_PER_SCOPE {
                    project.push(row.public);
                }
            } else if session.len() < MAX_CONTEXT_ATTACHMENTS_PER_SCOPE {
                session.push(row.public);
            }
        }
        let included_count = project
            .iter()
            .chain(session.iter())
            .filter(|a| a.included_in_context)
            .count();
        let estimated_total_tokens = project
            .iter()
            .chain(session.iter())
            .filter(|a| a.included_in_context)
            .map(|a| a.estimated_tokens.unwrap_or(0))
            .sum();
        let estimated_chars = project
            .iter()
            .chain(session.iter())
            .filter(|a| a.included_in_context)
            .map(estimated_chars)
            .sum::<usize>();
        Ok(ContextAttachmentList {
            project_id: project_id.to_owned(),
            session_id: session_id.map(str::to_owned),
            project_attachments: project,
            session_attachments: session,
            included_count,
            estimated_total_tokens,
            over_budget: estimated_chars > MAX_CONTEXT_CHARS_TOTAL,
        })
    }
    pub fn get_internal(
        &self,
        id: &str,
        session_id: Option<&str>,
    ) -> Result<StoredContextAttachment, AppError> {
        let connection = self.db.connection()?;
        let query = format!("{SELECT} WHERE a.id=?2");
        connection
            .query_row(&query, params![session_id, id], parse_row)
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Context attachment {id} was not found")))
    }
    pub fn list_by_ids(
        &self,
        ids: &[String],
        session_id: Option<&str>,
    ) -> Result<Vec<ContextAttachment>, AppError> {
        let mut out = Vec::new();
        for id in ids {
            if let Ok(value) = self.get_internal(id, session_id) {
                out.push(value.public);
            }
        }
        Ok(out)
    }
    pub fn find_duplicate(
        &self,
        project_id: &str,
        session_id: Option<&str>,
        dedupe_key: &str,
    ) -> Result<Option<StoredContextAttachment>, AppError> {
        let connection = self.db.connection()?;
        let query =
            format!("{SELECT} WHERE a.project_id=?2 AND a.session_key=?3 AND a.dedupe_key=?4");
        connection
            .query_row(
                &query,
                params![
                    session_id,
                    project_id,
                    session_id.unwrap_or("-"),
                    dedupe_key
                ],
                parse_row,
            )
            .optional()
            .map_err(AppError::from)
    }
    pub fn insert_file(&self, input: FileInsert) -> Result<StoredContextAttachment, AppError> {
        self.assert_capacity(&input.project_id, input.session_id.as_deref())?;
        let connection = self.db.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let key = input.session_id.as_deref().unwrap_or("-");
        let order: i64 = transaction.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM context_attachments WHERE project_id=?1 AND session_key=?2", params![input.project_id, key], |r| r.get(0))?;
        transaction.execute("INSERT INTO context_attachments(id,project_id,scope,session_id,session_key,kind,origin,title,note,dedupe_key,sort_order,default_include,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'file',?6,?7,NULL,?8,?9,?10,?11,?11)", params![input.id,input.project_id,scope_string(input.scope),input.session_id,key,origin_string(input.origin),input.title,input.sha256,order,input.default_include as i64,input.created_at])?;
        transaction.execute("INSERT INTO context_attachment_files(attachment_id,display_name,mime_type,size,sha256,storage_dir,file_name,extraction_state) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending')", params![input.id,input.display_name,input.mime_type,input.size as i64,input.sha256,input.storage_dir,input.file_name])?;
        if let Some(session) = input.session_id.as_deref() {
            selection_tx(
                &transaction,
                session,
                &input.id,
                input.default_include,
                &input.created_at,
            )?;
        }
        transaction.commit()?;
        drop(connection);
        self.get_internal(&input.id, input.session_id.as_deref())
    }
    pub fn insert_link(&self, input: LinkInsert) -> Result<StoredContextAttachment, AppError> {
        self.assert_capacity(&input.project_id, input.session_id.as_deref())?;
        let connection = self.db.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let key = input.session_id.as_deref().unwrap_or("-");
        let order: i64 = transaction.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM context_attachments WHERE project_id=?1 AND session_key=?2", params![input.project_id,key], |r| r.get(0))?;
        transaction.execute("INSERT INTO context_attachments(id,project_id,scope,session_id,session_key,kind,origin,title,note,dedupe_key,sort_order,default_include,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'link',?6,?7,NULL,?8,?9,?10,?11,?11)", params![input.id,input.project_id,scope_string(input.scope),input.session_id,key,origin_string(input.origin),input.title,input.normalized_url,order,input.default_include as i64,input.created_at])?;
        transaction.execute("INSERT INTO context_attachment_links(attachment_id,url,host,preview_state) VALUES(?1,?2,?3,'pending')", params![input.id,input.url,input.host])?;
        if let Some(session) = input.session_id.as_deref() {
            selection_tx(
                &transaction,
                session,
                &input.id,
                input.default_include,
                &input.created_at,
            )?;
        }
        transaction.commit()?;
        drop(connection);
        self.get_internal(&input.id, input.session_id.as_deref())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        id: &str,
        title: Option<&str>,
        note: Option<Option<&str>>,
        scope: Option<ContextAttachmentScope>,
        session_id: Option<Option<&str>>,
        sort_order: Option<usize>,
        updated_at: &str,
    ) -> Result<StoredContextAttachment, AppError> {
        let old = self.get_internal(id, None)?;
        let new_scope = scope.unwrap_or(old.public.scope);
        let new_session = session_id.unwrap_or(old.public.session_id.as_deref());
        validate_scope(new_scope, new_session).map_err(AppError::Validation)?;
        let connection = self.db.connection()?;
        connection.execute("UPDATE context_attachments SET title=COALESCE(?1,title),note=CASE WHEN ?2 THEN ?3 ELSE note END,scope=?4,session_id=?5,session_key=?6,sort_order=COALESCE(?7,sort_order),default_include=?8,updated_at=?9 WHERE id=?10",params![title,note.is_some(),note.flatten(),scope_string(new_scope),new_session,new_session.unwrap_or("-"),sort_order,new_scope==ContextAttachmentScope::Session,updated_at,id])?;
        if let Some(session) = new_session {
            if old.public.session_id.as_deref() != Some(session) {
                selection(&connection, session, id, true, updated_at)?;
            }
        }
        drop(connection);
        self.get_internal(id, new_session)
    }
    pub fn set_inclusion(
        &self,
        session: &str,
        ids: &[String],
        included: bool,
        updated_at: &str,
    ) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        let transaction = connection.unchecked_transaction()?;
        for id in ids {
            selection_tx(&transaction, session, id, included, updated_at)?;
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn update_extraction(
        &self,
        id: &str,
        state: ExtractionState,
        chars: Option<usize>,
        pages: Option<usize>,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        let changed=self.db.connection()?.execute("UPDATE context_attachment_files SET extraction_state=?1,extracted_chars=?2,page_count=?3,extraction_error=?4 WHERE attachment_id=?5",params![extraction_string(state),chars.map(|v|v as i64),pages.map(|v|v as i64),error.map(|v|v.chars().take(500).collect::<String>()),id])?;
        if changed == 1 {
            Ok(())
        } else {
            Err(AppError::NotFound(
                "Context attachment file was not found".to_owned(),
            ))
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update_link_preview(
        &self,
        id: &str,
        state: LinkPreviewState,
        title: Option<&str>,
        description: Option<&str>,
        site_name: Option<&str>,
        image_file: Option<&str>,
        error: Option<&str>,
        fetched_at: Option<&str>,
    ) -> Result<(), AppError> {
        let changed=self.db.connection()?.execute("UPDATE context_attachment_links SET preview_state=?1,preview_title=?2,preview_description=?3,preview_site_name=?4,preview_image_file=?5,preview_error=?6,fetched_at=?7 WHERE attachment_id=?8",params![preview_string(state),title.map(|v|v.chars().take(300).collect::<String>()),description.map(|v|v.chars().take(1000).collect::<String>()),site_name.map(|v|v.chars().take(200).collect::<String>()),image_file,error.map(|v|v.chars().take(500).collect::<String>()),fetched_at,id])?;
        if changed == 1 {
            Ok(())
        } else {
            Err(AppError::NotFound(
                "Context attachment link was not found".to_owned(),
            ))
        }
    }
    pub fn remove(&self, id: &str) -> Result<Option<StoredContextAttachment>, AppError> {
        let old = match self.get_internal(id, None) {
            Ok(value) => Some(value),
            Err(AppError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };
        if old.is_some() {
            self.db
                .connection()?
                .execute("DELETE FROM context_attachments WHERE id=?1", [id])?;
        }
        Ok(old)
    }
    pub fn count_file_references(&self, sha: &str) -> Result<usize, AppError> {
        Ok(self.db.connection()?.query_row(
            "SELECT COUNT(*) FROM context_attachment_files WHERE sha256=?1",
            [sha],
            |r| r.get::<_, i64>(0),
        )? as usize)
    }
    pub fn referenced_hashes(&self) -> Result<HashSet<String>, AppError> {
        let connection = self.db.connection()?;
        let mut statement =
            connection.prepare("SELECT DISTINCT sha256 FROM context_attachment_files")?;
        let rows = statement
            .query_map([], |r| r.get(0))?
            .collect::<Result<HashSet<String>, _>>()?;
        drop(statement);
        Ok(rows)
    }
    fn assert_capacity(&self, project: &str, session: Option<&str>) -> Result<(), AppError> {
        let count: i64 = self.db.connection()?.query_row(
            "SELECT COUNT(*) FROM context_attachments WHERE project_id=?1 AND session_key=?2",
            params![project, session.unwrap_or("-")],
            |r| r.get(0),
        )?;
        if count >= MAX_CONTEXT_ATTACHMENTS_PER_SCOPE as i64 {
            Err(AppError::Conflict(format!(
                "Pro Bereich sind höchstens {MAX_CONTEXT_ATTACHMENTS_PER_SCOPE} Anhänge möglich."
            )))
        } else {
            Ok(())
        }
    }
}

fn selection_tx(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    id: &str,
    included: bool,
    at: &str,
) -> Result<(), rusqlite::Error> {
    tx.execute("INSERT INTO context_attachment_selections(session_id,attachment_id,included,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,attachment_id) DO UPDATE SET included=excluded.included,updated_at=excluded.updated_at",params![session,id,included as i64,at]).map(|_|())
}
fn selection(
    c: &rusqlite::Connection,
    session: &str,
    id: &str,
    included: bool,
    at: &str,
) -> Result<(), AppError> {
    c.execute("INSERT INTO context_attachment_selections(session_id,attachment_id,included,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,attachment_id) DO UPDATE SET included=excluded.included,updated_at=excluded.updated_at",params![session,id,included as i64,at])?;
    Ok(())
}
fn scope_string(v: ContextAttachmentScope) -> &'static str {
    if v == ContextAttachmentScope::Session {
        "session"
    } else {
        "project"
    }
}
fn origin_string(v: ContextAttachmentOrigin) -> &'static str {
    if v == ContextAttachmentOrigin::Chat {
        "chat"
    } else {
        "manual"
    }
}
fn extraction_string(v: ExtractionState) -> &'static str {
    match v {
        ExtractionState::Pending => "pending",
        ExtractionState::Running => "running",
        ExtractionState::Ready => "ready",
        ExtractionState::Empty => "empty",
        ExtractionState::Unsupported => "unsupported",
        ExtractionState::TooLarge => "too_large",
        ExtractionState::Failed => "failed",
    }
}
fn preview_string(v: LinkPreviewState) -> &'static str {
    match v {
        LinkPreviewState::Pending => "pending",
        LinkPreviewState::Ready => "ready",
        LinkPreviewState::Unauthorized => "unauthorized",
        LinkPreviewState::Blocked => "blocked",
        LinkPreviewState::Disabled => "disabled",
        LinkPreviewState::Failed => "failed",
    }
}
fn estimated_chars(a: &ContextAttachment) -> usize {
    if let Some(f) = &a.file {
        f.extracted_chars
            .unwrap_or(0)
            .min(MAX_CONTEXT_CHARS_PER_ATTACHMENT)
    } else {
        a.estimated_tokens.unwrap_or(0) * 4
    }
}

struct Row {
    id: String,
    project: String,
    scope: String,
    session: Option<String>,
    session_key: String,
    kind: String,
    origin: Option<String>,
    title: String,
    note: Option<String>,
    dedupe: String,
    sort: i64,
    default: i64,
    created: String,
    updated: String,
    included: i64,
    display: Option<String>,
    mime: Option<String>,
    size: Option<i64>,
    sha: Option<String>,
    storage: Option<String>,
    filename: Option<String>,
    extraction: Option<String>,
    chars: Option<i64>,
    pages: Option<i64>,
    extraction_error: Option<String>,
    url: Option<String>,
    host: Option<String>,
    preview: Option<String>,
    preview_title: Option<String>,
    preview_description: Option<String>,
    site: Option<String>,
    image: Option<String>,
    preview_error: Option<String>,
    fetched: Option<String>,
}
fn parse_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredContextAttachment> {
    let r = Row {
        id: row.get(0)?,
        project: row.get(1)?,
        scope: row.get(2)?,
        session: row.get(3)?,
        session_key: row.get(4)?,
        kind: row.get(5)?,
        origin: row.get(6)?,
        title: row.get(7)?,
        note: row.get(8)?,
        dedupe: row.get(9)?,
        sort: row.get(10)?,
        default: row.get(11)?,
        created: row.get(12)?,
        updated: row.get(13)?,
        included: row.get(14)?,
        display: row.get(15)?,
        mime: row.get(16)?,
        size: row.get(17)?,
        sha: row.get(18)?,
        storage: row.get(19)?,
        filename: row.get(20)?,
        extraction: row.get(21)?,
        chars: row.get(22)?,
        pages: row.get(23)?,
        extraction_error: row.get(24)?,
        url: row.get(25)?,
        host: row.get(26)?,
        preview: row.get(27)?,
        preview_title: row.get(28)?,
        preview_description: row.get(29)?,
        site: row.get(30)?,
        image: row.get(31)?,
        preview_error: row.get(32)?,
        fetched: row.get(33)?,
    };
    let scope = if r.scope == "session" {
        ContextAttachmentScope::Session
    } else {
        ContextAttachmentScope::Project
    };
    let kind = if r.kind == "link" {
        ContextAttachmentKind::Link
    } else {
        ContextAttachmentKind::File
    };
    let file = if kind == ContextAttachmentKind::File {
        Some(ContextAttachmentFile {
            display_name: r.display.clone().ok_or(rusqlite::Error::InvalidQuery)?,
            mime_type: r.mime.clone().ok_or(rusqlite::Error::InvalidQuery)?,
            size: r.size.ok_or(rusqlite::Error::InvalidQuery)? as u64,
            sha256: r.sha.clone().ok_or(rusqlite::Error::InvalidQuery)?,
            extraction_state: parse_extraction(r.extraction.as_deref()),
            extracted_chars: r.chars.map(|v| v as usize),
            page_count: r.pages.map(|v| v as usize),
            extraction_error: r.extraction_error.clone(),
            renderable: matches!(
                r.mime.as_deref(),
                Some("image/png") | Some("image/jpeg") | Some("image/webp") | Some("image/gif")
            ),
        })
    } else {
        None
    };
    let link = if kind == ContextAttachmentKind::Link {
        Some(ContextAttachmentLink {
            url: r.url.clone().ok_or(rusqlite::Error::InvalidQuery)?,
            host: r.host.clone().ok_or(rusqlite::Error::InvalidQuery)?,
            preview_state: parse_preview(r.preview.as_deref()),
            preview_title: r.preview_title.clone(),
            preview_description: r.preview_description.clone(),
            preview_site_name: r.site.clone(),
            has_preview_image: r.image.is_some(),
            preview_error: r.preview_error.clone(),
            fetched_at: r.fetched.clone(),
        })
    } else {
        None
    };
    let estimated_tokens = if let Some(f) = &file {
        f.extracted_chars
            .map(|v| v.min(MAX_CONTEXT_CHARS_PER_ATTACHMENT).div_ceil(4))
    } else {
        Some(
            [
                r.title.as_str(),
                r.url.as_deref().unwrap_or(""),
                r.preview_title.as_deref().unwrap_or(""),
                r.preview_description.as_deref().unwrap_or(""),
                r.site.as_deref().unwrap_or(""),
            ]
            .join("\n")
            .chars()
            .count()
            .div_ceil(4),
        )
    };
    let public = ContextAttachment {
        id: r.id.clone(),
        project_id: r.project,
        scope,
        session_id: r.session,
        kind,
        origin: parse_origin(r.origin.as_deref()),
        title: r.title,
        note: r.note,
        sort_order: r.sort as usize,
        included_in_context: r.included != 0,
        estimated_tokens,
        file,
        link,
        created_at: r.created,
        updated_at: r.updated,
    };
    Ok(StoredContextAttachment {
        public,
        dedupe_key: r.dedupe,
        default_include: r.default != 0,
        session_key: r.session_key,
        storage_dir: r.storage,
        file_name: r.filename,
        preview_image_file: r.image,
    })
}
fn parse_origin(value: Option<&str>) -> ContextAttachmentOrigin {
    if value == Some("chat") {
        ContextAttachmentOrigin::Chat
    } else {
        ContextAttachmentOrigin::Manual
    }
}
fn parse_extraction(value: Option<&str>) -> ExtractionState {
    match value.unwrap_or("failed") {
        "pending" => ExtractionState::Pending,
        "running" => ExtractionState::Running,
        "ready" => ExtractionState::Ready,
        "empty" => ExtractionState::Empty,
        "unsupported" => ExtractionState::Unsupported,
        "too_large" => ExtractionState::TooLarge,
        _ => ExtractionState::Failed,
    }
}
fn parse_preview(value: Option<&str>) -> LinkPreviewState {
    match value.unwrap_or("failed") {
        "pending" => LinkPreviewState::Pending,
        "ready" => LinkPreviewState::Ready,
        "unauthorized" => LinkPreviewState::Unauthorized,
        "blocked" => LinkPreviewState::Blocked,
        "disabled" => LinkPreviewState::Disabled,
        _ => LinkPreviewState::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::{ContextAttachmentRepository, FileInsert};
    use crate::context_attachments::contracts::{ContextAttachmentOrigin, ContextAttachmentScope};
    use crate::db::DbPool;

    fn database_with_project() -> DbPool {
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
        db
    }

    #[test]
    fn insert_file_releases_connection_before_nested_public_read() {
        let db = database_with_project();
        let repository = ContextAttachmentRepository::new(db);
        let started = std::time::Instant::now();
        let value = repository
            .insert_file(FileInsert {
                id: "attachment".to_owned(),
                project_id: "project".to_owned(),
                scope: ContextAttachmentScope::Project,
                session_id: None,
                title: "notes.txt".to_owned(),
                origin: ContextAttachmentOrigin::Manual,
                display_name: "notes.txt".to_owned(),
                mime_type: "text/plain".to_owned(),
                size: 5,
                sha256: "a".repeat(64),
                storage_dir: "/tmp".to_owned(),
                file_name: "blob".to_owned(),
                default_include: false,
                created_at: "2026-01-01T00:00:00Z".to_owned(),
            })
            .unwrap();
        assert_eq!(value.public.id, "attachment");
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
