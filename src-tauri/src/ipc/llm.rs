//! Tauri command handlers for LLM transport and provider key management.
//! See spec §4.1 for the full command surface.

use crate::providers::error::RustError;
use crate::providers::provider::{LlmProvider, ProviderConfig};
use crate::providers::rate_limit::RateLimiter;
use crate::providers::registry::{CancelGuard, Registry};
use crate::providers::types::{
    CallContext, LlmRequest, LlmResponse, LlmStreamChunk, ModelConfig, UsageInfo,
};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

fn provider_for(
    reg: &Arc<Registry>,
    provider_id: &str,
) -> Result<Box<dyn LlmProvider>, RustError> {
    let cfg = reg
        .get_config(provider_id)
        .ok_or_else(|| RustError::provider_not_found(provider_id))?;
    Ok(reg.build_provider(&cfg))
}

async fn check_rate_limit(
    rl: &Arc<RateLimiter>,
    db: &Arc<crate::db::Db>,
    provider_id: &str,
) -> Result<(), RustError> {
    db.with(|conn| rl.try_acquire_for_provider(provider_id, conn))
        .await
        .and_then(|acquired| {
            if acquired {
                Ok(())
            } else {
                Err(RustError::rate_limited("provider rate limit exceeded"))
            }
        })
}

#[tauri::command]
pub async fn llm_upsert_config(
    reg: State<'_, Arc<Registry>>,
    config: ProviderConfig,
) -> Result<(), RustError> {
    reg.upsert_config(config);
    Ok(())
}

#[tauri::command]
pub async fn llm_validate(
    reg: State<'_, Arc<Registry>>,
    provider_id: String,
) -> Result<bool, RustError> {
    let p = provider_for(&reg, &provider_id)?;
    // For validate, fetch the key without enforcing requires_key — let the
    // provider's own validate decide what to do with a None key.
    let key = reg.get_key(&provider_id, false)?;
    p.validate(key.as_deref()).await
}

#[tauri::command]
pub async fn llm_list_models(
    reg: State<'_, Arc<Registry>>,
    provider_id: String,
) -> Result<Vec<ModelConfig>, RustError> {
    let p = provider_for(&reg, &provider_id)?;
    let key = reg.get_key(&provider_id, false)?;
    p.list_models(key.as_deref()).await
}

#[tauri::command]
pub async fn llm_send(
    reg: State<'_, Arc<Registry>>,
    rl: State<'_, Arc<RateLimiter>>,
    db: State<'_, Arc<crate::db::Db>>,
    provider_id: String,
    request: LlmRequest,
    _ctx: CallContext,
    request_id: String,
) -> Result<LlmResponse, RustError> {
    let p = provider_for(&reg, &provider_id)?;

    // Rate limit (provider-keyed; Phase C will switch to agent-keyed).
    check_rate_limit(&rl, &db, &provider_id).await?;

    // Required-key check happens inside get_key.
    let mut key = reg.get_key(&provider_id, p.requires_key())?;

    // Register cancellation token (collision and pre-cancel handled inside).
    let token = reg.register_in_flight(&request_id)?;
    let _guard = CancelGuard::new(&reg, request_id.clone());

    // Try once; on 401/403 + auth-failure-rotation, retry once.
    let result = p.send(key.as_deref(), request.clone(), token.clone()).await;
    if let Err(ref e) = result {
        if (e.code == "PROVIDER_HTTP_401" || e.code == "PROVIDER_HTTP_403") && key.is_some() {
            let old = key.clone().unwrap();
            if reg.reread_on_auth_failure(&provider_id, &old)? {
                key = reg.get_key(&provider_id, p.requires_key())?;
                return p.send(key.as_deref(), request, token).await;
            }
        }
    }
    result
}

#[tauri::command]
pub async fn llm_stream(
    reg: State<'_, Arc<Registry>>,
    rl: State<'_, Arc<RateLimiter>>,
    db: State<'_, Arc<crate::db::Db>>,
    provider_id: String,
    request: LlmRequest,
    _ctx: CallContext,
    request_id: String,
    on_chunk: Channel<LlmStreamChunk>,
) -> Result<(), RustError> {
    let t = std::time::Instant::now();
    eprintln!("[rust:llm_stream] enter provider_id={} request_id={}", provider_id, request_id);
    let p = provider_for(&reg, &provider_id)?;
    eprintln!("[rust:llm_stream] provider_resolved t_ms={}", t.elapsed().as_millis());

    check_rate_limit(&rl, &db, &provider_id).await?;
    eprintln!("[rust:llm_stream] rate_limit_ok t_ms={}", t.elapsed().as_millis());

    let key = reg.get_key(&provider_id, p.requires_key())?;
    let token = reg.register_in_flight(&request_id)?;
    let _guard = CancelGuard::new(&reg, request_id.clone());
    eprintln!("[rust:llm_stream] guard_set t_ms={}", t.elapsed().as_millis());

    let chunk_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let cc = chunk_count.clone();
    let send_chunk: crate::providers::provider::StreamCallback = Box::new(move |chunk| {
        let n = cc.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if n == 1 {
            eprintln!("[rust:llm_stream] first_chunk_emitted t_ms={}", t.elapsed().as_millis());
        }
        let _ = on_chunk.send(chunk);
    });
    let result = p.stream(key.as_deref(), request, send_chunk, token).await;
    eprintln!(
        "[rust:llm_stream] exit chunks={} t_ms={} ok={}",
        chunk_count.load(std::sync::atomic::Ordering::Relaxed),
        t.elapsed().as_millis(),
        result.is_ok(),
    );
    result.map(|_: UsageInfo| ())
    // Note: streaming auth-failure retry is intentionally omitted — partial
    // chunks may have already been emitted to the channel; retrying would
    // produce duplicate output. The caller (JS proxy) sees PROVIDER_HTTP_401
    // and the user re-issues the request after fixing the key.
}

#[tauri::command]
pub fn llm_cancel(
    reg: State<'_, Arc<Registry>>,
    request_id: String,
) -> Result<(), RustError> {
    reg.cancel(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn provider_set_key(
    reg: State<'_, Arc<Registry>>,
    db: State<'_, Arc<crate::db::Db>>,
    provider_id: String,
    key: String,
) -> Result<(), RustError> {
    reg.set_key(&provider_id, &key)?;
    crate::audit::append_audit(&db, &crate::audit::AuditEntry {
        event_type: "provider.key_set".into(),
        actor: "user".into(),
        target_type: Some("provider".into()),
        target_id: Some(provider_id),
        details: None,
    }).await
}

#[tauri::command]
pub async fn provider_delete_key(
    reg: State<'_, Arc<Registry>>,
    db: State<'_, Arc<crate::db::Db>>,
    provider_id: String,
) -> Result<(), RustError> {
    reg.delete_key(&provider_id)?;
    crate::audit::append_audit(&db, &crate::audit::AuditEntry {
        event_type: "provider.key_deleted".into(),
        actor: "user".into(),
        target_type: Some("provider".into()),
        target_id: Some(provider_id),
        details: None,
    }).await
}

#[tauri::command]
pub fn provider_has_key(
    reg: State<'_, Arc<Registry>>,
    provider_id: String,
) -> Result<bool, RustError> {
    reg.has_key(&provider_id)
}

#[tauri::command]
pub fn provider_reload_keys(
    reg: State<'_, Arc<Registry>>,
) -> Result<(), RustError> {
    reg.clear_keys();
    Ok(())
}
