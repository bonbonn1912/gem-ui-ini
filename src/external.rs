use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenExternalHttpsInput {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct VoidResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn external_open_https_url(
    app: AppHandle,
    input: OpenExternalHttpsInput,
) -> Result<VoidResult, AppError> {
    let url = normalized_https_url(&input.url)?;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|_| AppError::Upstream("Der Link konnte nicht geöffnet werden.".to_owned()))?;
    Ok(VoidResult { ok: true })
}

fn normalized_https_url(value: &str) -> Result<String, AppError> {
    let mut url = value
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| AppError::Validation("Die Adresse ist keine gültige URL.".to_owned()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::Validation(
            "Nur HTTPS-Links ohne eingebettete Zugangsdaten sind erlaubt.".to_owned(),
        ));
    }
    url.set_fragment(None);
    if url.port() == Some(443) {
        let _ = url.set_port(None);
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalized_https_url;

    #[test]
    fn external_urls_are_https_only_and_normalized() {
        assert_eq!(
            normalized_https_url(" https://EXAMPLE.com:443/path#x ").unwrap(),
            "https://example.com/path"
        );
        assert!(normalized_https_url("http://example.com").is_err());
        assert!(normalized_https_url("https://user:password@example.com").is_err());
        assert!(normalized_https_url("file:///etc/passwd").is_err());
    }
}
