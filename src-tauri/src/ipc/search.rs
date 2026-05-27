use crate::providers::error::RustError;
use crate::providers::registry::Registry;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TavilyResult {
    pub title: String,
    pub url: String,
    pub content: String,
    pub score: f64,
}

/// Web search via the Tavily API. The key is read from the OS keychain (stored
/// under the reserved "tavily" id via provider_set_key) and never crosses to the
/// frontend. Returns cleaned results `[{title, url, content, score}]`.
#[tauri::command]
pub async fn tavily_search(
    reg: State<'_, Arc<Registry>>,
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<TavilyResult>, RustError> {
    // requires=true → returns Err(AUTH_MISSING) when no key is configured.
    let key = match reg.get_key("tavily", true)? {
        Some(k) => k,
        None => return Err(RustError::auth_missing("tavily")),
    };

    let body = serde_json::json!({
        "api_key": key,
        "query": query,
        "max_results": max_results.unwrap_or(5).min(20),
        "search_depth": "basic",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(RustError::from)?;

    let res = client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(RustError::from)?;

    let status = res.status();
    let json: serde_json::Value = res.json().await.map_err(RustError::from)?;
    if !status.is_success() {
        let msg = json
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("Tavily request failed");
        return Err(RustError::provider_http(status.as_u16(), format!("Tavily: {msg}")));
    }

    let results = json
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    let out = results
        .iter()
        .map(|r| TavilyResult {
            title: r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            url: r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            content: r.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            score: r.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0),
        })
        .collect();

    Ok(out)
}
