//! LLM provider transport — see docs/superpowers/specs/2026-05-18-phase-a-llm-transport-design.md

pub mod types;
pub mod error;
pub mod provider;
pub mod http;
pub mod debug_dump;
pub mod openai_compatible;
pub mod claude;
pub mod ollama;
pub mod local;
pub mod rate_limit;
pub mod registry;
