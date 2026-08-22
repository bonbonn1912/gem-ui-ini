//! Small GitLab REST client surface.  The transport is injected so the
//! mapper/service remain deterministic and can be tested without a network.

use crate::error::AppError;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn normalize_api_base_url(instance_url: &str) -> Result<(String, String), AppError> {
    let mut value = instance_url.trim().to_owned();
    if !value.contains("://") {
        value = format!("https://{value}");
    }
    let (scheme, rest) = value
        .split_once("://")
        .ok_or_else(|| AppError::Validation("GitLab-Instanz-URL ist ungültig.".into()))?;
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(AppError::Validation(
            "GitLab-Instanz-URLs müssen das HTTPS-Protokoll verwenden.".into(),
        ));
    }
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.contains('@') {
        return Err(AppError::Validation(
            "GitLab-Instanz-URLs dürfen keine Benutzerdaten enthalten.".into(),
        ));
    }
    let mut base_path = format!("/{path}").trim_end_matches('/').to_owned();
    if base_path.ends_with("/api/v4") {
        base_path.truncate(base_path.len() - "/api/v4".len());
    }
    let host = authority.to_ascii_lowercase();
    if host == "gitlab.com" || base_path.ends_with(".git") || base_path.contains("/-/") {
        base_path.clear();
    }
    let instance = format!("{}://{}{}", scheme.to_ascii_lowercase(), host, base_path);
    Ok((instance.clone(), format!("{instance}/api/v4")))
}

pub trait GitLabTransport: Send + Sync {
    fn request<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        token: &'a str,
        body: Option<Value>,
    ) -> GitLabTransportFuture<'a>;
}

pub type GitLabTransportFuture<'a> = std::pin::Pin<
    Box<
        dyn std::future::Future<Output = Result<(u16, HashMap<String, String>, Value), AppError>>
            + Send
            + 'a,
    >,
>;

/// Production HTTP transport.  `reqwest` is kept behind the transport trait
/// so tests can inject a deterministic fake without opening sockets.
pub struct ReqwestGitLabTransport {
    client: reqwest::Client,
}
impl ReqwestGitLabTransport {
    pub fn new(
        timeout: std::time::Duration,
        allow_self_signed_tls: bool,
    ) -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .danger_accept_invalid_certs(allow_self_signed_tls)
            .user_agent("GeminUI-Desktop-App")
            .build()
            .map_err(|error| AppError::Upstream(error.to_string()))?;
        Ok(Self { client })
    }
}
impl GitLabTransport for ReqwestGitLabTransport {
    fn request<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        token: &'a str,
        body: Option<Value>,
    ) -> GitLabTransportFuture<'a> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|e| AppError::Validation(e.to_string()))?;
            let mut request = self
                .client
                .request(method, url)
                .header("PRIVATE-TOKEN", token)
                .header("Accept", "application/json");
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request
                .send()
                .await
                .map_err(|e| AppError::Upstream(format!("GitLab-Netzwerkfehler: {e}")))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(key, value)| {
                    Some((
                        key.as_str().to_ascii_lowercase(),
                        value.to_str().ok()?.to_owned(),
                    ))
                })
                .collect();
            let value = response.json::<Value>().await.unwrap_or(Value::Null);
            Ok((status, headers, value))
        })
    }
}

#[derive(Debug, Clone)]
pub struct GitLabApiClient<T> {
    pub instance_url: String,
    pub api_base_url: String,
    token: String,
    pub transport: T,
}
impl<T: GitLabTransport> GitLabApiClient<T> {
    pub fn new(instance_url: &str, token: String, transport: T) -> Result<Self, AppError> {
        let (instance_url, api_base_url) = normalize_api_base_url(instance_url)?;
        Ok(Self {
            instance_url,
            api_base_url,
            token: token.trim().into(),
            transport,
        })
    }
    pub async fn current_user(&self) -> Result<Value, AppError> {
        self.request("GET", "/user", None).await
    }
    pub async fn project(&self, project: &str) -> Result<Value, AppError> {
        self.request(
            "GET",
            &format!("/projects/{}", encode_component(project)),
            None,
        )
        .await
    }
    pub async fn list_merge_requests(
        &self,
        project: &str,
        branch: Option<&str>,
    ) -> Result<Vec<Value>, AppError> {
        let query = branch
            .map(|value| {
                format!(
                    "?per_page=50&scope=all&state=opened&source_branch={}",
                    encode_query(value)
                )
            })
            .unwrap_or_else(|| "?per_page=50&scope=all".into());
        self.paginated(&format!(
            "/projects/{}/merge_requests{query}",
            encode_component(project)
        ))
        .await
    }
    pub async fn merge_request(&self, project: &str, iid: i64) -> Result<Value, AppError> {
        self.request(
            "GET",
            &format!(
                "/projects/{}/merge_requests/{iid}",
                encode_component(project)
            ),
            None,
        )
        .await
    }
    pub async fn discussions(&self, project: &str, iid: i64) -> Result<Vec<Value>, AppError> {
        self.paginated(&format!(
            "/projects/{}/merge_requests/{iid}/discussions?per_page=100",
            encode_component(project)
        ))
        .await
    }
    pub async fn resolve_discussion(
        &self,
        project: &str,
        iid: i64,
        discussion: &str,
        resolved: bool,
    ) -> Result<Value, AppError> {
        self.request(
            "PUT",
            &format!(
                "/projects/{}/merge_requests/{iid}/discussions/{}",
                encode_component(project),
                encode_component(discussion)
            ),
            Some(json!({"resolved": resolved})),
        )
        .await
    }
    pub async fn reply_discussion(
        &self,
        project: &str,
        iid: i64,
        discussion: &str,
        body: &str,
    ) -> Result<Value, AppError> {
        self.request(
            "POST",
            &format!(
                "/projects/{}/merge_requests/{iid}/discussions/{}/notes",
                encode_component(project),
                encode_component(discussion)
            ),
            Some(json!({"body": body})),
        )
        .await
    }
    pub async fn file_content(
        &self,
        project: &str,
        file_path: &str,
        reference: &str,
    ) -> Result<String, AppError> {
        let value = self
            .request(
                "GET",
                &format!(
                    "/projects/{}/repository/files/{}?ref={}",
                    encode_component(project),
                    encode_component(file_path),
                    encode_query(reference)
                ),
                None,
            )
            .await?;
        let content = value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if value.get("encoding").and_then(Value::as_str) == Some("base64") {
            return decode_base64(content).ok_or_else(|| {
                AppError::Upstream("GitLab-Dateiinhalt ist ungültig codiert.".into())
            });
        }
        Ok(content.into())
    }
    async fn paginated(&self, endpoint: &str) -> Result<Vec<Value>, AppError> {
        let mut endpoint = format!("{}{endpoint}", self.api_base_url);
        let mut result = Vec::new();
        for _ in 0..20 {
            let (status, headers, value) = self
                .transport
                .request("GET", &endpoint, &self.token, None)
                .await?;
            ensure_status(status, &value)?;
            let Some(items) = value.as_array() else { break };
            result.extend(items.iter().cloned());
            let Some(next) = headers
                .get("x-next-page")
                .filter(|value| value.parse::<u64>().ok().is_some_and(|page| page > 0))
            else {
                break;
            };
            endpoint = if endpoint.contains('?') {
                format!("{}&page={next}", endpoint)
            } else {
                format!("{}?page={next}", endpoint)
            };
        }
        Ok(result)
    }
    async fn request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let url = if endpoint.starts_with("http") {
            endpoint.into()
        } else {
            format!("{}{endpoint}", self.api_base_url)
        };
        let (status, _, value) = self
            .transport
            .request(method, &url, &self.token, body)
            .await?;
        ensure_status(status, &value)?;
        Ok(value)
    }
}

fn ensure_status(status: u16, value: &Value) -> Result<(), AppError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = value
        .get("message")
        .or_else(|| value.get("error_description"))
        .map(|v| {
            if v.is_string() {
                v.as_str().unwrap_or_default().to_owned()
            } else {
                v.to_string()
            }
        })
        .unwrap_or_default();
    let message = match status {
        401 => "GitLab-Token ist ungültig, abgelaufen oder hat unzureichende Rechte.".into(),
        403 => "Keine ausreichenden Berechtigungen für diese GitLab-Aktion.".into(),
        404 => "GitLab-Ressource nicht gefunden.".into(),
        429 => "GitLab Rate Limit erreicht. Bitte kurz warten.".into(),
        _ => format!(
            "GitLab API Fehler ({status}){}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ),
    };
    Err(AppError::Upstream(message))
}
pub fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn encode_query(value: &str) -> String {
    encode_component(value)
}
fn decode_base64(value: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in value.bytes().filter(|v| !v.is_ascii_whitespace()) {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        buffer = (buffer << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake;
    impl GitLabTransport for Fake {
        fn request<'a>(
            &'a self,
            _: &'a str,
            _url: &'a str,
            _: &'a str,
            _: Option<Value>,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<(u16, HashMap<String, String>, Value), AppError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Ok((200, HashMap::new(), json!([]))) })
        }
    }
    #[tokio::test]
    async fn project_path_is_encoded_as_one_segment() {
        let client = GitLabApiClient::new("https://gitlab.com", "token".into(), Fake).unwrap();
        let _ = client
            .list_merge_requests("group/project", None)
            .await
            .unwrap();
        assert!(encode_component("group/project").contains("%2F"));
    }
}
