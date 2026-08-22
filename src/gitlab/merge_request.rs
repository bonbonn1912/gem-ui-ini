use super::contracts::{GitLabMergeRequestSummary, GitLabUserSummary};
use super::discussion::normalize_avatar_url;
use crate::git::now_iso;
use serde_json::Value;

pub fn normalize_merge_request_state(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => value.to_owned(),
        None => "opened".into(),
    }
}

pub fn map_raw_merge_request(
    raw: &Value,
    target_project_path: &str,
) -> Option<GitLabMergeRequestSummary> {
    let project_id = number(raw, "project_id").filter(|value| *value > 0)?;
    let iid = number(raw, "iid").filter(|value| *value > 0)?;
    let diff_refs = raw.get("diff_refs");
    let title = bounded(string(raw, "title")?, 1_000);
    let draft = raw.get("draft").and_then(Value::as_bool).unwrap_or(false)
        || raw
            .get("work_in_progress")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || title.starts_with("Draft:")
        || title.starts_with("WIP:");
    Some(GitLabMergeRequestSummary {
        target_project_id: raw
            .get("target_project_id")
            .and_then(Value::as_i64)
            .unwrap_or(project_id),
        target_project_path: target_project_path.into(),
        iid,
        title,
        web_url: string(raw, "web_url").filter(|value| value.starts_with("https://"))?,
        state: normalize_merge_request_state(raw.get("state").and_then(Value::as_str)),
        draft,
        source_branch: bounded(string(raw, "source_branch")?, 1_024),
        target_branch: bounded(string(raw, "target_branch")?, 1_024),
        source_project_id: raw
            .get("source_project_id")
            .and_then(Value::as_i64)
            .unwrap_or(project_id),
        head_sha: diff_refs
            .and_then(|v| string(v, "head_sha"))
            .or_else(|| string(raw, "sha"))?,
        base_sha: diff_refs.and_then(|v| nullable_string(v, "base_sha")),
        start_sha: diff_refs.and_then(|v| nullable_string(v, "start_sha")),
        author: map_user(raw.get("author")),
        unresolved_count: raw
            .get("user_notes_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        updated_at: normalized_timestamp(string(raw, "updated_at")),
    })
}

pub fn sort_merge_requests(list: &mut [GitLabMergeRequestSummary], current_branch: Option<&str>) {
    let branch = current_branch.map(|v| v.trim().to_ascii_lowercase());
    list.sort_by(|left, right| {
        let rank = |value: &GitLabMergeRequestSummary| {
            let on_branch = branch
                .as_ref()
                .is_some_and(|branch| value.source_branch.to_ascii_lowercase() == *branch);
            match (on_branch, value.draft) {
                (true, false) => 0,
                (true, true) => 1,
                (false, false) => 2,
                (false, true) => 3,
            }
        };
        rank(left)
            .cmp(&rank(right))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| right.iid.cmp(&left.iid))
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRequestUrl {
    pub project_path: String,
    pub merge_request_iid: i64,
}
pub fn parse_merge_request_url(
    expected_instance_url: &str,
    value: &str,
) -> Option<MergeRequestUrl> {
    let expected = split_origin(expected_instance_url)?;
    let (_, host_path) = value.trim().split_once("://")?;
    let (authority, path) = host_path.split_once('/').unwrap_or((host_path, ""));
    let authority = authority
        .rsplit_once('@')
        .map(|(_, v)| v)
        .unwrap_or(authority);
    let (host, port) = authority
        .rsplit_once(':')
        .map_or((authority, None), |(host, port)| {
            (host, port.parse::<u16>().ok())
        });
    if host.to_ascii_lowercase() != expected.0 || port != expected.1 {
        return None;
    }
    let segments = path
        .split('/')
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    let marker = segments
        .iter()
        .position(|value| *value == "merge_requests")?;
    if marker == 0 || marker + 1 >= segments.len() {
        return None;
    }
    let iid = segments[marker + 1].parse::<i64>().ok()?;
    (iid > 0).then(|| MergeRequestUrl {
        project_path: segments[..marker]
            .iter()
            .copied()
            .filter(|v| *v != "-")
            .collect::<Vec<_>>()
            .join("/"),
        merge_request_iid: iid,
    })
}

fn split_origin(value: &str) -> Option<(String, Option<u16>)> {
    let (_, rest) = value.trim().split_once("://")?;
    let authority = rest.split('/').next()?;
    let authority = authority
        .rsplit_once('@')
        .map(|(_, v)| v)
        .unwrap_or(authority);
    let (host, port) = authority
        .rsplit_once(':')
        .map_or((authority, None), |(host, port)| (host, port.parse().ok()));
    Some((host.to_ascii_lowercase(), port))
}
fn map_user(value: Option<&Value>) -> GitLabUserSummary {
    let value = value.and_then(Value::as_object);
    GitLabUserSummary {
        id: value
            .and_then(|v| v.get("id"))
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .unwrap_or(1),
        username: value
            .and_then(|v| v.get("username"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .chars()
            .take(255)
            .collect(),
        name: value
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("GitLab User")
            .chars()
            .take(255)
            .collect(),
        avatar_url: value.and_then(|v| normalize_avatar_url(v.get("avatar_url"))),
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
fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn bounded(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn normalized_timestamp(value: Option<String>) -> String {
    let value = value.unwrap_or_default();
    let bytes = value.as_bytes();
    let valid = bytes.len() >= 20
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes[19..].ends_with(b"Z");
    if valid {
        value
    } else {
        now_iso()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_nested_url() {
        let value = parse_merge_request_url(
            "https://gitlab.company.com",
            "https://gitlab.company.com/team/subgroup/core/service/-/merge_requests/42",
        )
        .unwrap();
        assert_eq!(value.project_path, "team/subgroup/core/service");
        assert_eq!(value.merge_request_iid, 42);
    }
}
