//! Tolerant mapping of GitLab's evolving discussion payloads.

use super::contracts::*;
use crate::git::now_iso;
use serde_json::Value;

pub fn normalize_avatar_url(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    value.starts_with("https://").then(|| value.to_owned())
}

pub fn map_gitlab_discussions(
    raw: &[Value],
    current_head_sha: Option<&str>,
) -> Vec<GitLabDiscussion> {
    raw.iter()
        .filter_map(|discussion| {
            let id = string(discussion, "id")?;
            let raw_notes = discussion.get("notes")?.as_array()?;
            if raw_notes.is_empty() {
                return None;
            }
            let mut notes = Vec::new();
            let mut resolvable = false;
            let mut unresolved = false;
            for note in raw_notes.iter().take(500) {
                let position = note
                    .get("position")
                    .and_then(|v| (!v.is_null()).then(|| map_position(v, current_head_sha)));
                let note_resolvable = bool_value(note, "resolvable");
                let note_resolved = bool_value(note, "resolved");
                resolvable |= note_resolvable;
                unresolved |= note_resolvable && !note_resolved;
                notes.push(GitLabDiscussionNote {
                    id: number(note, "id")?,
                    note_type: note_type(note.get("type"), position.is_some()),
                    body: bounded(string(note, "body").unwrap_or_default(), 100_000),
                    author: map_user(note.get("author")),
                    system: bool_value(note, "system"),
                    resolvable: note_resolvable,
                    resolved: note_resolved,
                    resolved_by: note
                        .get("resolved_by")
                        .and_then(|v| (!v.is_null()).then(|| map_user(Some(v)))),
                    created_at: normalized_timestamp(string(note, "created_at")),
                    updated_at: normalized_timestamp(string(note, "updated_at")),
                    position,
                });
            }
            Some(GitLabDiscussion {
                id,
                individual_note: bool_value(discussion, "individual_note"),
                notes,
                resolvable,
                resolved: resolvable && !unresolved,
            })
        })
        .collect()
}

pub fn map_user(value: Option<&Value>) -> GitLabUserSummary {
    let value = value.and_then(Value::as_object);
    GitLabUserSummary {
        id: value
            .and_then(|v| v.get("id"))
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .unwrap_or(1),
        username: bounded(
            value
                .and_then(|v| v.get("username"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            255,
        ),
        name: bounded(
            value
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("GitLab User")
                .to_owned(),
            255,
        ),
        avatar_url: value.and_then(|v| normalize_avatar_url(v.get("avatar_url"))),
    }
}

fn map_position(value: &Value, current_head_sha: Option<&str>) -> GitLabDiffPosition {
    let string_or_empty = |key| string(value, key).unwrap_or_default();
    let head_sha = string_or_empty("head_sha");
    GitLabDiffPosition {
        position_type: match string(value, "position_type").as_deref() {
            Some("image") => GitLabPositionType::Image,
            Some("file") => GitLabPositionType::File,
            _ => GitLabPositionType::Text,
        },
        base_sha: string_or_empty("base_sha"),
        start_sha: string_or_empty("start_sha"),
        head_sha: head_sha.clone(),
        old_path: repo_path(nullable_string(value, "old_path")),
        new_path: repo_path(nullable_string(value, "new_path")),
        old_line: nullable_number(value, "old_line"),
        new_line: nullable_number(value, "new_line"),
        line_range: value
            .get("line_range")
            .and_then(|range| (!range.is_null()).then(|| map_line_range(range))),
        outdated: !head_sha.is_empty()
            && current_head_sha.is_some_and(|current| current != head_sha),
    }
}
fn map_line_range(value: &Value) -> GitLabLineRange {
    GitLabLineRange {
        start: map_side(value.get("start")),
        end: map_side(value.get("end")),
    }
}
fn map_side(value: Option<&Value>) -> GitLabLineRangeSide {
    GitLabLineRangeSide {
        line_code: value
            .and_then(|v| nullable_string(v, "line_code"))
            .map(|value| bounded(value, 255)),
        line_type: value
            .and_then(|v| nullable_string(v, "type"))
            .map(|value| bounded(value, 50)),
        old_line: value.and_then(|v| nullable_number(v, "old_line")),
        new_line: value.and_then(|v| nullable_number(v, "new_line")),
    }
}
fn note_type(value: Option<&Value>, has_position: bool) -> GitLabNoteType {
    match value.and_then(Value::as_str).map(str::trim) {
        Some("DiffNote") => GitLabNoteType::DiffNote,
        Some("DiscussionNote") => GitLabNoteType::DiscussionNote,
        Some("Note") => GitLabNoteType::Note,
        Some(value) if !value.is_empty() => GitLabNoteType::Unknown,
        _ if has_position => GitLabNoteType::DiffNote,
        _ => GitLabNoteType::DiscussionNote,
    }
}
fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn nullable_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| (!v.is_null()).then(|| v.as_str().unwrap_or_default().to_owned()))
}
fn nullable_number(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(|v| (!v.is_null()).then(|| v.as_u64()).flatten())
}
fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
fn bool_value(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn bounded(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn repo_path(value: Option<String>) -> Option<String> {
    let value = value?;
    let value = value.trim();
    if value.is_empty()
        || value.contains('\0')
        || value.starts_with('/')
        || value.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(bounded(value.to_owned(), 1024))
}

fn normalized_timestamp(value: Option<String>) -> String {
    let value = value.unwrap_or_default();
    if is_rfc3339_like(&value) {
        value
    } else {
        now_iso()
    }
}

fn is_rfc3339_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    for index in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !bytes.get(index).is_some_and(u8::is_ascii_digit) {
            return false;
        }
    }
    let suffix = &value[19..];
    suffix == "Z"
        || (suffix.len() == 6
            && matches!(suffix.as_bytes()[0], b'+' | b'-')
            && suffix.as_bytes()[3] == b':'
            && suffix.as_bytes()[1].is_ascii_digit()
            && suffix.as_bytes()[2].is_ascii_digit()
            && suffix.as_bytes()[4].is_ascii_digit()
            && suffix.as_bytes()[5].is_ascii_digit())
        || (suffix.len() > 7
            && suffix.as_bytes()[0] == b'.'
            && suffix.as_bytes()[suffix.len() - 1] == b'Z')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn detects_outdated_positions() {
        let result = map_gitlab_discussions(
            &[
                json!({"id":"d","notes":[{"id":1,"body":"x","author":{"id":1,"username":"u","name":"U"},"position":{"head_sha":"old","new_line":4}}]}),
            ],
            Some("new"),
        );
        assert!(result[0].notes[0].position.as_ref().unwrap().outdated);
    }
}
