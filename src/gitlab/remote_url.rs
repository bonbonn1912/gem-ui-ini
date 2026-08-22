//! GitLab remote URL parsing.  Credentials are never retained in the
//! sanitised representation.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedGitLabRemote {
    pub raw_url: String,
    pub sanitized_url: String,
    pub host: String,
    pub port: Option<u16>,
    pub instance_url: String,
    pub project_path: String,
}

pub fn parse_gitlab_remote_url(raw: &str) -> Option<ParsedGitLabRemote> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((left, path)) = trimmed.split_once(':') {
        if !left.contains("//") && !path.starts_with("//") {
            let host = left
                .rsplit_once('@')
                .map(|(_, value)| value)
                .unwrap_or(left)
                .trim()
                .to_ascii_lowercase();
            if valid_host(&host) {
                return build(trimmed, host, None, path);
            }
        }
    }
    let (scheme, authority_path) = trimmed.split_once("://")?;
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "https" | "http" | "ssh" | "git"
    ) {
        return None;
    }
    let authority_end = authority_path.find('/').unwrap_or(authority_path.len());
    let authority = &authority_path[..authority_end];
    let path = &authority_path[authority_end..];
    let authority = authority
        .rsplit_once('@')
        .map(|(_, value)| value)
        .unwrap_or(authority);
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            (host, Some(port))
        } else {
            return None;
        }
    } else {
        (authority, None)
    };
    if !valid_host(host) {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let project_path = clean_project_path(path)?;
    let instance = if (scheme.eq_ignore_ascii_case("https") && port == Some(443))
        || (scheme.eq_ignore_ascii_case("http") && port == Some(80))
        || port.is_none()
        || matches!(scheme, "ssh" | "git")
    {
        format!("https://{host}")
    } else {
        match port {
            Some(port) => format!("https://{host}:{port}"),
            None => format!("https://{host}"),
        }
    };
    let scheme = scheme.to_ascii_lowercase();
    let port_suffix = port.map(|value| format!(":{value}")).unwrap_or_default();
    let sanitized = format!("{scheme}://{host}{port_suffix}/{project_path}.git");
    Some(ParsedGitLabRemote {
        raw_url: trimmed.to_owned(),
        sanitized_url: sanitized,
        host,
        port,
        instance_url: instance,
        project_path,
    })
}

pub fn sanitize_remote_url(raw: &str) -> String {
    parse_gitlab_remote_url(raw)
        .map(|v| v.sanitized_url)
        .unwrap_or_else(|| raw.trim().to_owned())
}

fn build(raw: &str, host: String, port: Option<u16>, path: &str) -> Option<ParsedGitLabRemote> {
    let project_path = clean_project_path(path)?;
    Some(ParsedGitLabRemote {
        raw_url: raw.to_owned(),
        sanitized_url: format!("git@{host}:{project_path}.git"),
        host: host.clone(),
        port,
        instance_url: format!("https://{host}"),
        project_path,
    })
}
fn clean_project_path(path: &str) -> Option<String> {
    let path = path
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim().trim_start_matches('/').trim_end_matches('/'));
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\0'))
    {
        return None;
    }
    Some(path.split('/').map(str::trim).collect::<Vec<_>>().join("/"))
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_ssh_and_https_remotes() {
        assert_eq!(
            parse_gitlab_remote_url("git@gitlab.company.org:dept/repo.git")
                .unwrap()
                .project_path,
            "dept/repo"
        );
        let value =
            parse_gitlab_remote_url("https://gitlab.example.com/team/backend/api.git").unwrap();
        assert_eq!(value.instance_url, "https://gitlab.example.com");
        assert_eq!(
            sanitize_remote_url("https://oauth2:secret@gitlab.com/a/b.git"),
            "https://gitlab.com/a/b.git"
        );
    }
}
